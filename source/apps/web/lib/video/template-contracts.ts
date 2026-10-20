import type { CharacterBindingDisplay, CharacterReference } from "../characters/contracts";
/** Public, server-neutral contracts for private video templates and delivery. */
export type VideoFeedbackDecision = "satisfied_save_template" | "satisfied" | "needs_changes";

export type VideoTemplateSummary = {
  id: string;
  code: string;
  name: string;
  category: string;
  archived: boolean;
  latest_version_id: string;
  version_count: number;
  source_asset_id: string;
  source_sha256: string;
  source_duration: number;
  thumbnail_url: string | null;
  source_url: string | null;
  preview_url: string | null;
  created_at: string;
  updated_at: string;
};

export type VideoTemplateCreatePayload = {
  source_asset_id: string;
  product_asset_id: string;
  title: string;
  instructions: string;
  preserve_audio: boolean;
  generation_mode: "six_references";
  reference_assets: { asset_id: string; role: "product" | "character" | "scene" | "product_detail" | "start_state" | "end_state"; label: string; character_version_id?: string | null; image_index?: number }[];
  segment_plan: {
    start: number;
    source_duration: number;
    duration: 4 | 5 | 6 | 8;
    instructions: string;
    before_state: string;
    after_state: string;
    reference_assets: VideoTemplateCreatePayload["reference_assets"];
    start_from_segment?: number;
  }[];
};

export type VideoTemplateDetail = {
  template: VideoTemplateSummary;
  versions: { id: string; version: number; created_at: string; source_job_id: string; output_sha256: string }[];
  selected_version: { id: string; version: number; source_asset_id: string; source_sha256: string; output_sha256: string;
    workflow_profile: "sixref-v1"; recipe_schema_version: 1 | 2; create_payload: VideoTemplateCreatePayload; character_bindings: CharacterBindingDisplay[] };
};

export type VideoDeliveryMedia = { duration: number; width: number; height: number; fps?: number; frameCount?: number };
export type VideoDelivery = {
  job_id: string;
  title: string;
  status: string;
  output_sha256: string | null;
  output: { url: string; download_url: string; sha256: string; media: VideoDeliveryMedia | null } | null;
  source: { url: string; sha256: string | null; duration: number | null };
  segments: { index: number; accepted: boolean; url: string | null; download_url: string | null; sha256: string | null; media: VideoDeliveryMedia | null }[];
  feedback: { decision: VideoFeedbackDecision; notes: string; template_id: string | null; template_version_id: string | null } | null;
  character_references: CharacterReference[];
  can_feedback: boolean;
  template_save_supported: boolean;
};
