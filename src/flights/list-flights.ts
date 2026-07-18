import type { Flight, ValidationIssue } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export type RawListFlightsQuery = {
  page?: unknown;
  pageSize?: unknown;
};

export type ListFlightsSuccessResult = {
  outcome: "success";
  items: Flight[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
};

export type ListFlightsValidationFailure = {
  outcome: "validation_failed";
  issues: ValidationIssue[];
};

export type ListFlightsResult =
  | ListFlightsSuccessResult
  | ListFlightsValidationFailure;

export type ListFlights = (
  query: RawListFlightsQuery,
) => ListFlightsResult;

type ParsePaginationValueResult =
  | {
      success: true;
      value: number;
    }
  | {
      success: false;
      issue: ValidationIssue;
    };

function createPaginationIssue(
  field: "page" | "pageSize",
): ValidationIssue {
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

function parsePaginationValue(
  field: "page" | "pageSize",
  rawValue: unknown,
  defaultValue: number,
  maximum?: number,
): ParsePaginationValueResult {
  if (rawValue === undefined) {
    return {
      success: true,
      value: defaultValue,
    };
  }

  if (typeof rawValue !== "string") {
    return {
      success: false,
      issue: createPaginationIssue(field),
    };
  }

  const trimmed = rawValue.trim();

  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    return {
      success: false,
      issue: createPaginationIssue(field),
    };
  }

  const value = Number(trimmed);

  if (!Number.isSafeInteger(value) || value < 1) {
    return {
      success: false,
      issue: createPaginationIssue(field),
    };
  }

  if (maximum !== undefined && value > maximum) {
    return {
      success: false,
      issue: createPaginationIssue(field),
    };
  }

  return {
    success: true,
    value,
  };
}

type ListFlightsDependencies = {
  flightRepository: FlightRepository;
};

export function createListFlights(
  dependencies: ListFlightsDependencies,
): ListFlights {
  const { flightRepository } = dependencies;

  return function listFlights(
    rawQuery: RawListFlightsQuery,
  ): ListFlightsResult {
    const pageResult = parsePaginationValue(
      "page",
      rawQuery.page,
      DEFAULT_PAGE,
    );

    const pageSizeResult = parsePaginationValue(
      "pageSize",
      rawQuery.pageSize,
      DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );

    const issues: ValidationIssue[] = [];

    if (!pageResult.success) {
      issues.push(pageResult.issue);
    }

    if (!pageSizeResult.success) {
      issues.push(pageSizeResult.issue);
    }

    if (issues.length > 0) {
      return {
        outcome: "validation_failed",
        issues,
      };
    }

    // After validation both branches succeeded; narrow for TypeScript.
    if (!pageResult.success || !pageSizeResult.success) {
      return {
        outcome: "validation_failed",
        issues,
      };
    }

    const page = pageResult.value;
    const pageSize = pageSizeResult.value;
    const offset = (page - 1) * pageSize;

    if (!Number.isSafeInteger(offset)) {
      return {
        outcome: "validation_failed",
        issues: [createPaginationIssue("page")],
      };
    }

    const repositoryResult = flightRepository.findPage({
      limit: pageSize,
      offset,
    });

    const totalPages = Math.ceil(
      repositoryResult.totalItems / pageSize,
    );

    return {
      outcome: "success",
      items: repositoryResult.items,
      pagination: {
        page,
        pageSize,
        totalItems: repositoryResult.totalItems,
        totalPages,
      },
    };
  };
}
