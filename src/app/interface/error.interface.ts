export interface TErrorSource {
  path: string | number;
  message: string;
}

export interface TErrorResponse {
  success: false;
  statusCode: number;
  message: string;
  errorSources: TErrorSource[];
  stack?: string | null;
}
