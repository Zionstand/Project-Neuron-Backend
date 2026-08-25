// One pagination contract for every list endpoint.
//
// Shape matches what the audit log already returned ({ rows, total }) so there
// is a single convention rather than two, with page/pageSize echoed back — the
// client needs them to render "page 3 of 16" without restating its own request.
//
// Deliberately NOT applied to the LIE worklist (GET /schools): that response is
// cached wholesale for offline capture, so an inspector who loaded page 1 would
// go into the field able to work only the first 25 schools. It stays complete
// and is paged in the browser instead.

export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

// Tolerant by design: a bad or missing value yields page 1 rather than an error.
// These arrive from query strings, and a 400 on "?page=" helps nobody.
export function parsePage(
  page?: string | number,
  pageSize?: string | number,
  opts: { defaultSize?: number; maxSize?: number } = {},
): PageParams {
  const maxSize = opts.maxSize ?? MAX_PAGE_SIZE;
  const n = (v: string | number | undefined, fallback: number) => {
    const parsed = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  const size = Math.min(n(pageSize, opts.defaultSize ?? DEFAULT_PAGE_SIZE), maxSize);
  const current = n(page, 1);
  return {
    page: current,
    pageSize: size,
    skip: (current - 1) * size,
    take: size,
  };
}

export function paged<T>(
  rows: T[],
  total: number,
  params: PageParams,
): Paged<T> {
  return { rows, total, page: params.page, pageSize: params.pageSize };
}
