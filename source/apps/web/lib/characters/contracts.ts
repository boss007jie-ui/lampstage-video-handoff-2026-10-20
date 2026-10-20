/** Browser-safe contracts. Image URLs retain the existing public-media behavior. */
export type CharacterSummary = {
  id: string; code: string; name: string; category: string; archived: boolean;
  latest_version_id: string; version_count: number; reference_count: number;
  cover_url: string | null; created_at: string; updated_at: string;
};
export type CharacterVersionDetail = {
  id: string; version: number; description: string; content_digest: string; created_at: string;
  reference_assets: Array<{ index: number; asset_id: string; label: string; image_url: string;
    sha256: string; size_bytes: number; width: number; height: number }>;
};
export type CharacterDetail = { character: CharacterSummary;
  versions: Array<{ id: string; version: number; created_at: string }>;
  selected_version: CharacterVersionDetail };
export type CharacterSaveInput = { idempotency_key: string; name: string; category?: string;
  description?: string; reference_assets: Array<{ asset_id: string; label: string }> };
export type CharacterVersionInput = { expected_latest_version_id: string; description?: string;
  reference_assets: CharacterSaveInput["reference_assets"] };
export type CharacterSaveResponse = { character: CharacterSummary; selected_version: CharacterVersionDetail; reused: boolean };
export type CharacterAsset = { asset_id: string; image_url: string; width: number; height: number; sha256: string | null; created_at: string };
export type CharacterListResponse = { characters: CharacterSummary[]; next_cursor: string | null };
export type CharacterAssetListResponse = { assets: CharacterAsset[]; next_cursor: string | null };
export type CharacterAssetUploadResponse = { asset_id: string; id: string; image_url: string; width: number;
  height: number; sha256: string; reused_content: boolean };
export type CharacterBindingDisplay = { segment_index: number; reference_index: number; character_id: string;
  code: string; name: string; character_version_id: string; version: number; image_index: number };
export type CharacterReference = { asset_id: string; label: string; image_url: string; sha256: string | null;
  character_id?: string; character_version_id?: string; image_index?: number };
