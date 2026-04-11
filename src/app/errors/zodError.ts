import { ZodError } from 'zod';
import { TErrorSource } from '../interface/error.interface';

export function handleZodError(err: ZodError): {
  statusCode: number;
  message: string;
  errorSources: TErrorSource[];
} {
  return {
    statusCode: 400,
    message: 'Validation Error',
    errorSources: err.issues.map((issue) => ({
      path: String(issue.path.at(-1) ?? ''),
      message: issue.message,
    })),
  };
}
