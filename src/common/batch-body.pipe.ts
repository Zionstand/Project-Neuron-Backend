import {
  BadRequestException,
  Injectable,
  ValidationPipe,
} from '@nestjs/common';
// `import type` is required: `Type` appears in a decorated constructor signature
// and this project builds with isolatedModules + emitDecoratorMetadata.
import type { PipeTransform, Type } from '@nestjs/common';

// A request body that was either a single record or an array of them.
export interface BatchBody<T> {
  items: T[];
  /** True when the client sent one object, so the response can mirror the shape. */
  single: boolean;
}

const MAX_BATCH = 500;

// Accepts `{...}` or `[{...}, {...}]` on the same route, so an inspector's device
// can drain a queue of offline captures in one request instead of one round trip
// per row over a 3G link. Each item runs through the same validation the global
// pipe applies to a single body — the array itself is never trusted.
//
// Nest's own ParseArrayPipe rejects a non-array outright, which would break every
// existing single-record caller, hence this wrapper.
@Injectable()
export class BatchBodyPipe<T> implements PipeTransform<unknown, Promise<BatchBody<T>>> {
  private readonly validator: ValidationPipe;

  constructor(private readonly itemType: Type<T>) {
    // Mirrors the global pipe's options (see main.ts) so a batched item is held
    // to exactly the same contract as a singly-posted one.
    this.validator = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      expectedType: itemType,
    });
  }

  async transform(value: unknown): Promise<BatchBody<T>> {
    const single = !Array.isArray(value);
    const raw = single ? [value] : (value as unknown[]);

    if (raw.length === 0) {
      throw new BadRequestException('The request body contained no records.');
    }
    if (raw.length > MAX_BATCH) {
      throw new BadRequestException(
        `Too many records in one request (max ${MAX_BATCH}). Send them in smaller batches.`,
      );
    }

    const items: T[] = [];
    for (const [i, item] of raw.entries()) {
      try {
        items.push(
          (await this.validator.transform(item, {
            type: 'body',
            metatype: this.itemType,
          })) as T,
        );
      } catch (err) {
        // Point at the offending row — a 400 with no index is unusable when the
        // client is replaying dozens of queued records.
        if (single) throw err;
        const detail =
          err instanceof BadRequestException
            ? (err.getResponse() as any)?.message
            : 'Invalid record.';
        throw new BadRequestException({
          message: `Record ${i + 1} of ${raw.length} is invalid.`,
          index: i,
          errors: detail,
        });
      }
    }

    return { items, single };
  }
}
