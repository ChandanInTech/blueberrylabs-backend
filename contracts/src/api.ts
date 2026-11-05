import type { ApiErrorBody, ErrorCode } from "./errors";
import type { Format, Platform } from "./presets";
import type { AssetKind, GenerationStatus, ProcessingStep, UploadStatus } from "./status";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface DemoSession {
  user: { id: string; kind: "DEMO" };
  expiresAt: string;
  /** Double-submit CSRF token; echoed in the `X-CSRF-Token` header. */
  csrfToken: string;
}

export type DemoSessionResponse = DemoSession;
export type SessionResponse = DemoSession;

// ---------------------------------------------------------------------------
// Uploads and assets
// ---------------------------------------------------------------------------

export interface CreateUploadRequest {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface CreateUploadResponse {
  assetId: string;
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface CompleteUploadResponse {
  assetId: string;
  uploadStatus: UploadStatus;
}

export interface AssetMetadata {
  assetId: string;
  kind: AssetKind;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  uploadStatus: UploadStatus;
  createdAt: string;
}

export interface SignedUrlResponse {
  url: string;
  expiresAt: string;
  mimeType: string;
  filename: string;
}

// ---------------------------------------------------------------------------
// Generations
// ---------------------------------------------------------------------------

export interface CreateGenerationRequest {
  assetId: string;
  platform: Platform;
  format: Format;
}

export interface GenerationOutput {
  assetId: string;
  width: number;
  height: number;
  mimeType: string;
  sizeBytes: number;
}

export interface GenerationError {
  code: ErrorCode;
  message: string;
}

export interface Generation {
  id: string;
  status: GenerationStatus;
  progress: number;
  currentStep: ProcessingStep;
  message: string | null;
  platform: Platform;
  format: Format;
  inputAssetId: string;
  output: GenerationOutput | null;
  error: GenerationError | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type GenerationStatusResponse = Generation;

export interface CreateGenerationResponse {
  generationId: string;
  status: GenerationStatus;
  progress: number;
}

export interface GenerationListItem {
  id: string;
  status: GenerationStatus;
  progress: number;
  platform: Platform;
  format: Format;
  createdAt: string;
  completedAt: string | null;
  /** Signed thumbnail URL; short-lived, never persisted. */
  thumbnailUrl: string | null;
}

export interface GenerationListResponse {
  items: GenerationListItem[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok" | "degraded";
  checks?: Record<string, "ok" | "error">;
}

export type { ApiErrorBody, ErrorCode };
