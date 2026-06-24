import { IsIn } from 'class-validator';

export const SECTION_KEYS = [
  'asc',
  'students',
  'staff',
  'security',
  'media',
] as const;

export class SectionDto {
  @IsIn(SECTION_KEYS as unknown as string[]) section: string;
}
