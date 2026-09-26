export interface PalletizationRules {
  allow_mixed_pallets: boolean;
  max_pallet_weight_kg?: number;
  prefer_full_pallets: boolean;
}

export interface PalletBox {
  id: string;
  order_line_id: string | null;
  article_code: string | null;
  article_description?: string | null;
  lg_code: string | null;
  store_code: string | null;
  layer_number: number;
  pos_x_mm: number;
  pos_y_mm: number;
  pos_z_mm: number;
  box_length_mm: number;
  box_width_mm: number;
  box_height_mm: number;
  rotated: boolean;
  orientation?: string | null;
  quantity: number;
}

export interface PalletPlanResult {
  id: string;
  pallet_number: number;
  pallet_size: string;
  base_length_mm: number;
  base_width_mm: number;
  height_mm: number;
  total_layers: number;
  total_boxes: number;
  total_pieces: number;
  is_mixed: boolean;
  base_usage_pct: number | null;
  warnings: string[];
  lg_codes: string[];
  store_codes: string[];
  soc_code?: string | null;
  boxes: PalletBox[];
}

export interface BuildPalletPlanResponse {
  success: boolean;
  data?: {
    order_id: string;
    total_pallets: number;
    total_boxes: number;
    pallets: PalletPlanResult[];
    warnings: string[];
    preview?: boolean;
    requires_choice?: boolean;
    preview_digest?: string;
    blocking_errors?: string[];
  };
  error?: string;
}

export type PalletPlanSelection = 'keep' | 'split';

export type PalletPlanEdit =
  | { type: 'move_store'; from_pallet: number; to_pallet: number | null; store_code: string }
  | { type: 'resize_pallet'; pallet_number: number; size: '120x80' | '60x80' | '120x100' };

export interface PalletPlanPreviewData extends NonNullable<BuildPalletPlanResponse['data']> {
  preview: true;
  requires_choice: boolean;
  preview_digest: string;
  blocking_errors: string[];
}
