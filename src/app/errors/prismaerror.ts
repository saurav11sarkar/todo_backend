import { HttpStatus } from '@nestjs/common';
import { Prisma } from 'prisma/generated/prisma/client';
import { TErrorSource } from '../interface/error.interface';

export function handlePrismaError(
  err:
    | Prisma.PrismaClientKnownRequestError
    | Prisma.PrismaClientValidationError
    | Prisma.PrismaClientUnknownRequestError
    | Prisma.PrismaClientInitializationError
    | Prisma.PrismaClientRustPanicError,
): {
  statusCode: number;
  message: string;
  errorSources: TErrorSource[];
} {
  // ── 1. Known Request Errors (P2xxx / P1xxx) ──────────────────────────────
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      // Unique constraint violation
      case 'P2002': {
        const fields = (err.meta?.target as string[]) ?? [];
        return {
          statusCode: HttpStatus.CONFLICT,
          message: 'Duplicate Entry',
          errorSources: fields.map((f) => ({
            path: f,
            message: `'${f}' already exists`,
          })),
        };
      }

      // Foreign key constraint violation
      case 'P2003': {
        const field = (err.meta?.field_name as string) ?? 'unknown field';
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Related Record Not Found',
          errorSources: [
            { path: field, message: `Related record not found for: ${field}` },
          ],
        };
      }

      // Record not found / required relation missing
      case 'P2025': {
        const cause =
          (err.meta?.cause as string) ?? 'Required record not found';
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record Not Found',
          errorSources: [{ path: '', message: cause }],
        };
      }

      // Record does not exist (findUniqueOrThrow / updateOrThrow)
      case 'P2001': {
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record Not Found',
          errorSources: [
            { path: '', message: 'The requested record does not exist' },
          ],
        };
      }

      // Null constraint violation
      case 'P2011': {
        const field = (err.meta?.constraint as string) ?? 'unknown field';
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Null Constraint Violation',
          errorSources: [
            { path: field, message: `Field '${field}' cannot be null` },
          ],
        };
      }

      // Missing required value
      case 'P2012': {
        const field = (err.meta?.path as string) ?? 'unknown field';
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Missing Required Field',
          errorSources: [
            { path: field, message: `Missing required value for '${field}'` },
          ],
        };
      }

      // Relation violation
      case 'P2014': {
        const relation = (err.meta?.relation_name as string) ?? 'unknown';
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Relation Violation',
          errorSources: [
            {
              path: relation,
              message: `The change would violate the required relation '${relation}'`,
            },
          ],
        };
      }

      // Value too long for column
      case 'P2000': {
        const field = (err.meta?.column_name as string) ?? 'unknown field';
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Value Too Long',
          errorSources: [
            {
              path: field,
              message: `The value provided for '${field}' is too long`,
            },
          ],
        };
      }

      // Invalid value for field type
      case 'P2005':
      case 'P2006': {
        const field = (err.meta?.field_name as string) ?? 'unknown field';
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Invalid Field Value',
          errorSources: [
            {
              path: field,
              message: `Invalid value provided for field '${field}'`,
            },
          ],
        };
      }

      // Table does not exist
      case 'P2021': {
        const table = (err.meta?.table as string) ?? 'unknown table';
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database Schema Error',
          errorSources: [
            { path: '', message: `Table '${table}' does not exist` },
          ],
        };
      }

      // Column does not exist
      case 'P2022': {
        const column = (err.meta?.column as string) ?? 'unknown column';
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database Schema Error',
          errorSources: [
            { path: '', message: `Column '${column}' does not exist` },
          ],
        };
      }

      // Database auth failed
      case 'P1000': {
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database Authentication Failed',
          errorSources: [
            {
              path: '',
              message: 'Database authentication failed — check credentials',
            },
          ],
        };
      }

      // Cannot reach database
      case 'P1001': {
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Database Unreachable',
          errorSources: [
            {
              path: '',
              message:
                'Cannot reach the database server — check connection settings',
            },
          ],
        };
      }

      // Database timeout
      case 'P1008': {
        return {
          statusCode: HttpStatus.REQUEST_TIMEOUT,
          message: 'Database Timeout',
          errorSources: [{ path: '', message: 'Database operation timed out' }],
        };
      }

      // Database does not exist
      case 'P1003': {
        return {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Database Not Found',
          errorSources: [
            { path: '', message: 'The specified database does not exist' },
          ],
        };
      }

      // Too many connections
      case 'P2037': {
        return {
          statusCode: HttpStatus.SERVICE_UNAVAILABLE,
          message: 'Too Many Database Connections',
          errorSources: [
            {
              path: '',
              message: 'Too many database connections opened — try again later',
            },
          ],
        };
      }

      // Fallback for any other known error code
      default: {
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Database Error',
          errorSources: [
            { path: '', message: `Database error occurred: ${err.code}` },
          ],
        };
      }
    }
  }

  // ── 2. Validation Error (wrong types / missing fields in query) ───────────
  if (err instanceof Prisma.PrismaClientValidationError) {
    const lines = err.message
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const usefulLine = lines[lines.length - 1] ?? 'Invalid data provided';
    return {
      statusCode: HttpStatus.BAD_REQUEST,
      message: 'Database Validation Error',
      errorSources: [{ path: '', message: usefulLine }],
    };
  }

  // ── 3. Unknown Request Error ──────────────────────────────────────────────
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Unknown Database Error',
      errorSources: [
        { path: '', message: 'An unknown database error occurred' },
      ],
    };
  }

  // ── 4. Initialization Error (connection / env issues) ────────────────────
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return {
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      message: 'Database Connection Failed',
      errorSources: [
        {
          path: '',
          message:
            'Failed to initialize database connection — service unavailable',
        },
      ],
    };
  }

  // ── 5. Rust Panic (critical engine crash) ────────────────────────────────
  if (err instanceof Prisma.PrismaClientRustPanicError) {
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Critical Database Error',
      errorSources: [
        {
          path: '',
          message:
            'A critical database engine error occurred — please restart the server',
        },
      ],
    };
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  return {
    statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Database Error',
    errorSources: [
      { path: '', message: 'An unexpected database error occurred' },
    ],
  };
}
