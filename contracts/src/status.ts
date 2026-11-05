export const GENERATION_STATUSES = ["QUEUED", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const TERMINAL_GENERATION_STATUSES: readonly GenerationStatus[] = ["COMPLETED", "FAILED"];

export function isGenerationStatus(value: unknown): value is GenerationStatus {
  return typeof value === "string" && (GENERATION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalGenerationStatus(value: GenerationStatus): boolean {
  return value === "COMPLETED" || value === "FAILED";
}

/** Processing stages, in order. */
export const PROCESSING_STEPS = [
  "QUEUED",
  "VALIDATING_INPUT",
  "DOWNLOADING_INPUT",
  "RESIZING_IMAGE",
  "UPLOADING_OUTPUT",
  "FINALIZING",
  "COMPLETED",
] as const;
export type ProcessingStep = (typeof PROCESSING_STEPS)[number];

/** Stage -> progress mapping from the architecture document, section 10.2. */
export const STEP_PROGRESS: Record<ProcessingStep, number> = {
  QUEUED: 0,
  VALIDATING_INPUT: 10,
  DOWNLOADING_INPUT: 20,
  RESIZING_IMAGE: 55,
  UPLOADING_OUTPUT: 85,
  FINALIZING: 95,
  COMPLETED: 100,
};

export function progressForStep(step: ProcessingStep): number {
  return STEP_PROGRESS[step];
}

/** The next step, or `null` when the step is already terminal. */
export function nextStep(step: ProcessingStep): ProcessingStep | null {
  const index = PROCESSING_STEPS.indexOf(step);
  if (index < 0 || index === PROCESSING_STEPS.length - 1) return null;
  return PROCESSING_STEPS[index + 1] ?? null;
}

export const GENERATION_EVENT_TYPES = ["QUEUED", "PROCESSING", "PROGRESS", "COMPLETED", "FAILED"] as const;
export type GenerationEventType = (typeof GENERATION_EVENT_TYPES)[number];

export const UPLOAD_STATUSES = ["PENDING", "UPLOADED", "FAILED"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const ASSET_KINDS = ["IMAGE"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const JOB_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TYPES = ["PROCESS_IMAGE"] as const;
export type JobType = (typeof JOB_TYPES)[number];
