export type AppRole = 'admin' | 'operador' | 'etiquetas' | 'pendente';
export type OrderStatus = 'importado' | 'validado' | 'paletizado' | 'etiquetas_geradas';

export interface Profile {
  id: string;
  user_id: string;
  name: string;
  email: string;
  must_change_password?: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserRole {
  id: string;
  user_id: string;
  role: AppRole;
}

export interface Article {
  id: string;
  code: string;
  description: string;
  unit: string;
  weight_kg: number | null;
  dimensions_cm: string | null;
  pieces_per_box: number;
  boxes_per_pallet: number;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Packaging {
  id: string;
  code: string;
  description: string;
  type: string;
  dimensions_cm: string | null;
  max_weight_kg: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface EDIFile {
  id: string;
  filename: string;
  storage_path: string;
  file_size: number | null;
  status: string;
  imported_by: string | null;
  imported_at: string;
  processed_at: string | null;
  error_message: string | null;
}

export interface Order {
  id: string;
  edi_file_id: string | null;
  order_number: string;
  customer_code: string | null;
  customer_name: string | null;
  delivery_date: string | null;
  delivery_site_id: string | null;
  status: OrderStatus;
  total_items: number;
  total_pallets: number;
  notes: string | null;
  soc_code: string | null;
  store_code: string | null;
  lg_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderLine {
  id: string;
  order_id: string;
  line_number: number;
  article_id: string | null;
  article_code: string;
  article_description: string | null;
  quantity: number;
  unit: string;
  lg_code: string | null;
  store_code: string | null;
  warehouse_code: string | null;
  quantity_cases: number | null;
  asn_number: string | null;
  asn_item_num: string | null;
  created_at: string;
}

export interface PalletizationPlan {
  id: string;
  order_id: string;
  pallet_number: number;
  packaging_id: string | null;
  total_boxes: number;
  total_weight_kg: number | null;
  notes: string | null;
  created_at: string;
}

export interface PalletItem {
  id: string;
  palletization_plan_id: string;
  order_line_id: string | null;
  quantity: number;
  box_number: number | null;
  created_at: string;
}

export interface Label {
  id: string;
  order_id: string;
  palletization_plan_id: string | null;
  label_type: string;
  label_data: Record<string, unknown> | null;
  pdf_storage_path: string | null;
  generated_at: string;
  generated_by: string | null;
}

export interface OperationHistory {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  performed_by: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  importado: 'Importado',
  validado: 'Validado',
  paletizado: 'Paletizado',
  etiquetas_geradas: 'Etiquetas Geradas',
};

export const ORDER_STATUS_FLOW: OrderStatus[] = [
  'importado',
  'validado', 
  'paletizado',
  'etiquetas_geradas'
];
