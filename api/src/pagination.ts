import type { ValidationIssue, ValidationResult } from "./types.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type RawPageQuery = {
  page?: unknown;
  pageSize?: unknown;
};

/** Validated page request, already translated to repository terms. */
export type PageQuery = {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
};

export type Pagination = {
  page: number;
  pageSize: number;
  /** Total in the collection (or scope), not on the current page. */
  totalItems: number;
  totalPages: number;
};

function createPaginationIssue(field: "page" | "pageSize"): ValidationIssue {
  if (field === "page") {
    return {
      field: "page",
      code: "INVALID_PAGE",
      message: "page must be a positive integer",
    };
  }

  return {
    field: "pageSize",
    code: "INVALID_PAGE_SIZE",
    message: "pageSize must be an integer between 1 and 100",
  };
}

type ParsePaginationValueResult =
  | { success: true; value: number }
  | { success: false; issue: ValidationIssue };

function parsePaginationValue(
  field: "page" | "pageSize",
  rawValue: unknown,
  defaultValue: number,
  maximum?: number,
): ParsePaginationValueResult {
  if (rawValue === undefined) {
    return { success: true, value: defaultValue };
  }

  if (typeof rawValue !== "string") {
    return { success: false, issue: createPaginationIssue(field) };
  }

  const trimmed = rawValue.trim();

  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return { success: false, issue: createPaginationIssue(field) };
  }

  const value = Number(trimmed);

  if (!Number.isSafeInteger(value) || value < 1) {
    return { success: false, issue: createPaginationIssue(field) };
  }

  if (maximum !== undefined && value > maximum) {
    return { success: false, issue: createPaginationIssue(field) };
  }

  return { success: true, value };
}

/**
 * Offset pagination shared by every list endpoint: `page` ≥ 1 (default 1),
 * `pageSize` 1–100 (default 20). Moved here from list-flights.ts on Day 44
 * when bookings became the second list.
 */
export function parsePageQuery(
  rawQuery: RawPageQuery,
): ValidationResult<PageQuery> {
  const pageResult = parsePaginationValue("page", rawQuery.page, DEFAULT_PAGE);
  const pageSizeResult = parsePaginationValue(
    "pageSize",
    rawQuery.pageSize,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );

  if (!pageResult.success || !pageSizeResult.success) {
    const issues: ValidationIssue[] = [];
    if (!pageResult.success) {
      issues.push(pageResult.issue);
    }
    if (!pageSizeResult.success) {
      issues.push(pageSizeResult.issue);
    }
    return { success: false, issues };
  }

  const page = pageResult.value;
  const pageSize = pageSizeResult.value;
  const offset = (page - 1) * pageSize;

  if (!Number.isSafeInteger(offset)) {
    return { success: false, issues: [createPaginationIssue("page")] };
  }

  return {
    success: true,
    value: { page, pageSize, limit: pageSize, offset },
  };
}

export function toPagination(query: PageQuery, totalItems: number): Pagination {
  return {
    page: query.page,
    pageSize: query.pageSize,
    totalItems,
    totalPages: Math.ceil(totalItems / query.pageSize),
  };
}
