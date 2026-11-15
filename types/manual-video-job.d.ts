export type ManualVideoJobStatus =
  | "queued"
  | "segmenting"
  | "segments_ready"
  | "waiting_for_tts_service"
  | "audio_generating"
  | "audio_quality_checking"
  | "audio_ready"
  | "subtitle_generating"
  | "subtitle_ready"
  | "image_planning"
  | "images_ready"
  | "waiting_for_video_service"
  | "video_generating"
  | "video_ready"
  | "manual_review_required"
  | "completed"
  | "failed"
  | "cancelled";

export type SegmentAudioStatus = "pending" | "generating" | "generated" | "failed";
export type ManualImageSource = "upload" | "library";
export type AspectRatio = "3:2" | "16:9" | "9:16" | "1:1";
export type SubtitlePosition = "top" | "center" | "bottom";

export interface ManualVideoJobInput {
  title: string;
  subtitle_text: string;
  speech_text: string;
  request_note: string;
}

export interface ManualVideoSegment {
  id: string;
  order: number;
  subtitle_text: string;
  speech_text: string;
  image_id: string | null;
  requested_image_duration_seconds: number | null;
  audio: {
    status: SegmentAudioStatus;
    path: string | null;
    duration_seconds: number | null;
    error: string | null;
  };
  timing: {
    start_seconds: number | null;
    end_seconds: number | null;
  };
}

export interface ManualVideoImage {
  id: string;
  source: ManualImageSource;
  order: number;
  segment_ids: string[];
  requested_duration_seconds: number | null;
  original_filename: string;
  stored_filename: string | null;
  stored_path: string | null;
  sha256: string | null;
  start_seconds?: number | null;
  end_seconds?: number | null;
  duration_seconds?: number | null;
  library_asset_id?: string | null;
}

export interface ManualVideoJobError {
  stage: ManualVideoJobStatus;
  code: string;
  message: string;
  retryable: boolean;
  segment_id: string | null;
}

export interface ManualVideoJobV2 {
  version: 2;
  mode: "manual";
  job_id: string;
  status: ManualVideoJobStatus;
  current_stage: ManualVideoJobStatus;
  created_at: string;
  updated_at: string;
  input: ManualVideoJobInput;
  segments: ManualVideoSegment[];
  images: ManualVideoImage[];
  output: {
    filename: string | null;
    aspect_ratio: AspectRatio;
    subtitle_size: number;
    subtitle_position: SubtitlePosition;
  };
  artifacts: {
    audio_file: string | null;
    subtitle_file: string | null;
    video_file: string | null;
  };
  voice_profile: string;
  voice_generation?: {
    version: 1;
    seed: number;
    profile: string;
    conditioning_mode: "caption_only" | "caption_and_reference" | null;
    reference_audio_used: boolean;
    profile_fingerprint: string | null;
    profile_snapshot: {
      model: string;
      caption: string;
      reference_audio: null;
      steps: number;
      tempo: number;
      duration_scale: number;
      t_schedule_mode: string;
      sway_coeff: number;
      cfg_guidance_mode: string;
      cfg_scale_text: number;
      cfg_scale_caption: number;
      cfg_scale_speaker: number;
      cfg_scale: number | null;
      cfg_min_t: number;
      cfg_max_t: number;
      context_kv_cache: boolean;
    } | null;
  };
  audio_quality?: {
    version: 1;
    status: "passed" | "attention";
    checked_at: string;
    f0_is_diagnostic_alone: false;
    baselines: Record<string, number | null>;
    segments: Array<{ segment_id: string; speech_characters: number; metrics: Record<string, number | string | null> }>;
    anomalies: Array<{ segment_id: string; reasons: string[]; metrics: Record<string, number | string | null> }>;
    regeneration_count: number;
    max_regenerations: number;
  } | null;
  attempts: number;
  history: Array<{
    at: string;
    stage: ManualVideoJobStatus;
    message: string;
  }>;
  review: {
    required: boolean;
    reasons: string[];
  };
  error: ManualVideoJobError | null;
  regeneration?: {
    source_job_id: string;
    requested_at: string;
    kind?: "full_material_reuse" | "anomalous_audio_segments";
    segment_ids?: string[];
    audio_quality_regeneration_count?: number;
    reused_segment_audio: boolean;
    reused_assembled_audio: boolean;
    reused_subtitle: boolean;
    reused_images: boolean;
  } | null;
  archive?: {
    status: "local_only" | "nas_saved";
    saved_at: string;
    local_archive_path: string;
    nas_archive_path: string | null;
    error: string | null;
  } | null;
}
