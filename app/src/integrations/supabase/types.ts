export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      articles: {
        Row: {
          active: boolean | null
          boxes_per_layer: number | null
          boxes_per_pallet: number | null
          code: string
          created_at: string
          description: string
          dimensions_cm: string | null
          ean: string | null
          id: string
          layers_per_pallet: number | null
          pieces_per_box: number | null
          unit: string
          updated_at: string
          weight_kg: number | null
        }
        Insert: {
          active?: boolean | null
          boxes_per_layer?: number | null
          boxes_per_pallet?: number | null
          code: string
          created_at?: string
          description: string
          dimensions_cm?: string | null
          ean?: string | null
          id?: string
          layers_per_pallet?: number | null
          pieces_per_box?: number | null
          unit?: string
          updated_at?: string
          weight_kg?: number | null
        }
        Update: {
          active?: boolean | null
          boxes_per_layer?: number | null
          boxes_per_pallet?: number | null
          code?: string
          created_at?: string
          description?: string
          dimensions_cm?: string | null
          ean?: string | null
          id?: string
          layers_per_pallet?: number | null
          pieces_per_box?: number | null
          unit?: string
          updated_at?: string
          weight_kg?: number | null
        }
        Relationships: []
      }
      delivery_sites: {
        Row: {
          active: boolean | null
          address: string | null
          city: string
          created_at: string
          customer_type: string | null
          id: string
          internal_code: string
          label_name: string
          postal_code: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean | null
          address?: string | null
          city: string
          created_at?: string
          customer_type?: string | null
          id?: string
          internal_code: string
          label_name: string
          postal_code?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean | null
          address?: string | null
          city?: string
          created_at?: string
          customer_type?: string | null
          id?: string
          internal_code?: string
          label_name?: string
          postal_code?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      edi_files: {
        Row: {
          error_message: string | null
          file_size: number | null
          filename: string
          id: string
          imported_at: string
          imported_by: string | null
          processed_at: string | null
          status: string
          storage_path: string
        }
        Insert: {
          error_message?: string | null
          file_size?: number | null
          filename: string
          id?: string
          imported_at?: string
          imported_by?: string | null
          processed_at?: string | null
          status?: string
          storage_path: string
        }
        Update: {
          error_message?: string | null
          file_size?: number | null
          filename?: string
          id?: string
          imported_at?: string
          imported_by?: string | null
          processed_at?: string | null
          status?: string
          storage_path?: string
        }
        Relationships: []
      }
      label_jobs: {
        Row: {
          completed_at: string | null
          created_by: string | null
          error_message: string | null
          id: string
          labels_count: number | null
          lg_code: string | null
          order_id: string
          pdf_storage_path: string | null
          started_at: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_by?: string | null
          error_message?: string | null
          id?: string
          labels_count?: number | null
          lg_code?: string | null
          order_id: string
          pdf_storage_path?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          created_by?: string | null
          error_message?: string | null
          id?: string
          labels_count?: number | null
          lg_code?: string | null
          order_id?: string
          pdf_storage_path?: string | null
          started_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "label_jobs_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      labels: {
        Row: {
          generated_at: string
          generated_by: string | null
          id: string
          label_data: Json | null
          label_type: string
          lg_code: string | null
          order_id: string
          palletization_plan_id: string | null
          pdf_storage_path: string | null
        }
        Insert: {
          generated_at?: string
          generated_by?: string | null
          id?: string
          label_data?: Json | null
          label_type: string
          lg_code?: string | null
          order_id: string
          palletization_plan_id?: string | null
          pdf_storage_path?: string | null
        }
        Update: {
          generated_at?: string
          generated_by?: string | null
          id?: string
          label_data?: Json | null
          label_type?: string
          lg_code?: string | null
          order_id?: string
          palletization_plan_id?: string | null
          pdf_storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "labels_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "labels_palletization_plan_id_fkey"
            columns: ["palletization_plan_id"]
            isOneToOne: false
            referencedRelation: "palletization_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      operation_history: {
        Row: {
          action: string
          created_at: string
          details: Json | null
          entity_id: string
          entity_type: string
          id: string
          performed_by: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json | null
          entity_id: string
          entity_type: string
          id?: string
          performed_by?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json | null
          entity_id?: string
          entity_type?: string
          id?: string
          performed_by?: string | null
        }
        Relationships: []
      }
      order_full_pallets: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          lines: Json
          order_id: string
          position: number
          store_code: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          lines: Json
          order_id: string
          position: number
          store_code: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          lines?: Json
          order_id?: string
          position?: number
          store_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "order_full_pallets_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      order_lines: {
        Row: {
          article_code: string
          article_description: string | null
          article_id: string | null
          asn_item_num: string | null
          asn_number: string | null
          created_at: string
          id: string
          lg_code: string | null
          line_number: number
          order_id: string
          quantity: number
          quantity_cases: number | null
          store_code: string | null
          unit: string | null
          warehouse_code: string | null
        }
        Insert: {
          article_code: string
          article_description?: string | null
          article_id?: string | null
          asn_item_num?: string | null
          asn_number?: string | null
          created_at?: string
          id?: string
          lg_code?: string | null
          line_number: number
          order_id: string
          quantity: number
          quantity_cases?: number | null
          store_code?: string | null
          unit?: string | null
          warehouse_code?: string | null
        }
        Update: {
          article_code?: string
          article_description?: string | null
          article_id?: string | null
          asn_item_num?: string | null
          asn_number?: string | null
          created_at?: string
          id?: string
          lg_code?: string | null
          line_number?: number
          order_id?: string
          quantity?: number
          quantity_cases?: number | null
          store_code?: string | null
          unit?: string | null
          warehouse_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "order_lines_article_id_fkey"
            columns: ["article_id"]
            isOneToOne: false
            referencedRelation: "articles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "order_lines_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
        ]
      }
      orders: {
        Row: {
          created_at: string
          customer_code: string | null
          customer_name: string | null
          delivery_date: string | null
          delivery_site_id: string | null
          edi_file_id: string | null
          id: string
          lg_code: string | null
          notes: string | null
          order_date: string | null
          order_number: string
          soc_code: string | null
          status: Database["public"]["Enums"]["order_status"]
          store_code: string | null
          total_items: number | null
          total_pallets: number | null
          transport_guide: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_code?: string | null
          customer_name?: string | null
          delivery_date?: string | null
          delivery_site_id?: string | null
          edi_file_id?: string | null
          id?: string
          lg_code?: string | null
          notes?: string | null
          order_date?: string | null
          order_number: string
          soc_code?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          store_code?: string | null
          total_items?: number | null
          total_pallets?: number | null
          transport_guide?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_code?: string | null
          customer_name?: string | null
          delivery_date?: string | null
          delivery_site_id?: string | null
          edi_file_id?: string | null
          id?: string
          lg_code?: string | null
          notes?: string | null
          order_date?: string | null
          order_number?: string
          soc_code?: string | null
          status?: Database["public"]["Enums"]["order_status"]
          store_code?: string | null
          total_items?: number | null
          total_pallets?: number | null
          transport_guide?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "orders_delivery_site_id_fkey"
            columns: ["delivery_site_id"]
            isOneToOne: false
            referencedRelation: "delivery_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "orders_edi_file_id_fkey"
            columns: ["edi_file_id"]
            isOneToOne: false
            referencedRelation: "edi_files"
            referencedColumns: ["id"]
          },
        ]
      }
      packaging: {
        Row: {
          active: boolean | null
          code: string
          created_at: string
          description: string
          dimensions_cm: string | null
          id: string
          max_weight_kg: number | null
          type: string
          updated_at: string
        }
        Insert: {
          active?: boolean | null
          code: string
          created_at?: string
          description: string
          dimensions_cm?: string | null
          id?: string
          max_weight_kg?: number | null
          type: string
          updated_at?: string
        }
        Update: {
          active?: boolean | null
          code?: string
          created_at?: string
          description?: string
          dimensions_cm?: string | null
          id?: string
          max_weight_kg?: number | null
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      pallet_items: {
        Row: {
          article_code: string | null
          box_height_mm: number | null
          box_length_mm: number | null
          box_number: number | null
          box_width_mm: number | null
          created_at: string
          id: string
          layer_number: number | null
          lg_code: string | null
          order_line_id: string | null
          orientation: string | null
          palletization_plan_id: string
          pos_x_mm: number | null
          pos_y_mm: number | null
          pos_z_mm: number | null
          quantity: number
          rotated: boolean
          soc_code: string | null
          store_code: string | null
        }
        Insert: {
          article_code?: string | null
          box_height_mm?: number | null
          box_length_mm?: number | null
          box_number?: number | null
          box_width_mm?: number | null
          created_at?: string
          id?: string
          layer_number?: number | null
          lg_code?: string | null
          order_line_id?: string | null
          orientation?: string | null
          palletization_plan_id: string
          pos_x_mm?: number | null
          pos_y_mm?: number | null
          pos_z_mm?: number | null
          quantity: number
          rotated?: boolean
          soc_code?: string | null
          store_code?: string | null
        }
        Update: {
          article_code?: string | null
          box_height_mm?: number | null
          box_length_mm?: number | null
          box_number?: number | null
          box_width_mm?: number | null
          created_at?: string
          id?: string
          layer_number?: number | null
          lg_code?: string | null
          order_line_id?: string | null
          orientation?: string | null
          palletization_plan_id?: string
          pos_x_mm?: number | null
          pos_y_mm?: number | null
          pos_z_mm?: number | null
          quantity?: number
          rotated?: boolean
          soc_code?: string | null
          store_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pallet_items_order_line_id_fkey"
            columns: ["order_line_id"]
            isOneToOne: false
            referencedRelation: "order_lines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pallet_items_palletization_plan_id_fkey"
            columns: ["palletization_plan_id"]
            isOneToOne: false
            referencedRelation: "palletization_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      pallet_store_containers: {
        Row: {
          created_at: string | null
          id: string
          lg_code: string | null
          palletization_plan_id: string
          soc_code: string
          store_code: string
          total_boxes: number | null
        }
        Insert: {
          created_at?: string | null
          id?: string
          lg_code?: string | null
          palletization_plan_id: string
          soc_code: string
          store_code: string
          total_boxes?: number | null
        }
        Update: {
          created_at?: string | null
          id?: string
          lg_code?: string | null
          palletization_plan_id?: string
          soc_code?: string
          store_code?: string
          total_boxes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "pallet_store_containers_palletization_plan_id_fkey"
            columns: ["palletization_plan_id"]
            isOneToOne: false
            referencedRelation: "palletization_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      palletization_plans: {
        Row: {
          base_length_mm: number | null
          base_usage_pct: number | null
          base_width_mm: number | null
          created_at: string
          height_mm: number | null
          id: string
          is_mixed: boolean
          lg_code: string | null
          notes: string | null
          order_id: string
          packaging_id: string | null
          pallet_number: number
          pallet_size: string | null
          single_label: boolean
          soc_code: string | null
          total_boxes: number | null
          total_layers: number | null
          total_pieces: number | null
          total_weight_kg: number | null
          warnings: Json
        }
        Insert: {
          base_length_mm?: number | null
          base_usage_pct?: number | null
          base_width_mm?: number | null
          created_at?: string
          height_mm?: number | null
          id?: string
          is_mixed?: boolean
          lg_code?: string | null
          notes?: string | null
          order_id: string
          packaging_id?: string | null
          pallet_number: number
          pallet_size?: string | null
          single_label?: boolean
          soc_code?: string | null
          total_boxes?: number | null
          total_layers?: number | null
          total_pieces?: number | null
          total_weight_kg?: number | null
          warnings?: Json
        }
        Update: {
          base_length_mm?: number | null
          base_usage_pct?: number | null
          base_width_mm?: number | null
          created_at?: string
          height_mm?: number | null
          id?: string
          is_mixed?: boolean
          lg_code?: string | null
          notes?: string | null
          order_id?: string
          packaging_id?: string | null
          pallet_number?: number
          pallet_size?: string | null
          single_label?: boolean
          soc_code?: string | null
          total_boxes?: number | null
          total_layers?: number | null
          total_pieces?: number | null
          total_weight_kg?: number | null
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "palletization_plans_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "palletization_plans_packaging_id_fkey"
            columns: ["packaging_id"]
            isOneToOne: false
            referencedRelation: "packaging"
            referencedColumns: ["id"]
          },
        ]
      }
      pd_internal_article_codes: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          ean: string
          id: string
          internal_code: string
          source_filename: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          ean: string
          id?: string
          internal_code: string
          source_filename?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          ean?: string
          id?: string
          internal_code?: string
          source_filename?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      pd_lg_locations: {
        Row: {
          active: boolean | null
          city_label: string | null
          company_id: string
          created_at: string
          customer_label: string | null
          delivery_internal_code: string | null
          id: string
          lg_number: string
          location_id: string
          name: string | null
          notes: string | null
          store_code: string | null
          supermarket_name: string | null
          updated_at: string
          warehouse_code: string | null
        }
        Insert: {
          active?: boolean | null
          city_label?: string | null
          company_id?: string
          created_at?: string
          customer_label?: string | null
          delivery_internal_code?: string | null
          id?: string
          lg_number: string
          location_id: string
          name?: string | null
          notes?: string | null
          store_code?: string | null
          supermarket_name?: string | null
          updated_at?: string
          warehouse_code?: string | null
        }
        Update: {
          active?: boolean | null
          city_label?: string | null
          company_id?: string
          created_at?: string
          customer_label?: string | null
          delivery_internal_code?: string | null
          id?: string
          lg_number?: string
          location_id?: string
          name?: string | null
          notes?: string | null
          store_code?: string | null
          supermarket_name?: string | null
          updated_at?: string
          warehouse_code?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          id: string
          must_change_password: boolean
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          must_change_password?: boolean
          name: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          must_change_password?: boolean
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      warehouse_addresses: {
        Row: {
          active: boolean
          address: string
          city: string
          country: string | null
          created_at: string
          id: string
          postcode: string
          source_filename: string | null
          updated_at: string
          warehouse_code: string
          warehouse_name: string
        }
        Insert: {
          active?: boolean
          address: string
          city: string
          country?: string | null
          created_at?: string
          id?: string
          postcode: string
          source_filename?: string | null
          updated_at?: string
          warehouse_code: string
          warehouse_name: string
        }
        Update: {
          active?: boolean
          address?: string
          city?: string
          country?: string | null
          created_at?: string
          id?: string
          postcode?: string
          source_filename?: string | null
          updated_at?: string
          warehouse_code?: string
          warehouse_name?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      bootstrap_admin: { Args: never; Returns: boolean }
      generate_soc_code: { Args: never; Returns: string }
      mark_order_delivered: {
        Args: { p_order_id: string; p_note?: string | null }
        Returns: Json
      }
      set_order_full_pallets: {
        Args: { p_order_id: string; p_pallets: Json }
        Returns: Json
      }
      order_change_block_reason: {
        Args: { p_order_id: string; p_actor_user_id: string | null }
        Returns: string | null
      }
      order_file_issued: { Args: { p_order_id: string }; Returns: boolean }
      order_is_delivered: { Args: { p_order_id: string }; Returns: boolean }
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
    }
    Enums: {
      app_role: "admin" | "operador" | "etiquetas" | "pendente"
      order_status:
        | "importado"
        | "validado"
        | "paletizado"
        | "etiquetas_geradas"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operador", "etiquetas", "pendente"],
      order_status: [
        "importado",
        "validado",
        "paletizado",
        "etiquetas_geradas",
      ],
    },
  },
} as const
