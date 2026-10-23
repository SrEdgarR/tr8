export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.18';
  };
  public: {
    Tables: {
      tr8_workspace_projects: {
        Row: {
          archived_at: string | null;
          code: string | null;
          color: string;
          created_at: string;
          description: string;
          id: string;
          name: string;
          owner_id: string;
          status: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        Insert: {
          archived_at?: string | null;
          code?: string | null;
          color?: string;
          created_at?: string;
          description?: string;
          id?: string;
          name: string;
          owner_id?: string;
          status?: string;
          updated_at?: string;
          version?: number;
          workspace_id: string;
        };
        Update: {
          archived_at?: string | null;
          code?: string | null;
          color?: string;
          created_at?: string;
          description?: string;
          id?: string;
          name?: string;
          owner_id?: string;
          status?: string;
          updated_at?: string;
          version?: number;
          workspace_id?: string;
        };
        Relationships: [];
      };
      tr8_workspace_tasks: {
        Row: {
          assignee_member_id: string | null;
          created_at: string;
          description: string;
          due_date: string | null;
          id: string;
          owner_id: string;
          position: number;
          priority: string;
          project_id: string;
          scheduled_end_at: string | null;
          scheduled_start_at: string | null;
          scheduled_time_zone: string | null;
          start_date: string | null;
          status: string;
          task_number: number;
          title: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        Insert: {
          assignee_member_id?: string | null;
          created_at?: string;
          description?: string;
          due_date?: string | null;
          id?: string;
          owner_id?: string;
          position?: number;
          priority?: string;
          project_id: string;
          scheduled_end_at?: string | null;
          scheduled_start_at?: string | null;
          scheduled_time_zone?: string | null;
          start_date?: string | null;
          status?: string;
          task_number?: never;
          title: string;
          updated_at?: string;
          version?: number;
          workspace_id: string;
        };
        Update: {
          assignee_member_id?: string | null;
          created_at?: string;
          description?: string;
          due_date?: string | null;
          id?: string;
          owner_id?: string;
          position?: number;
          priority?: string;
          project_id?: string;
          scheduled_end_at?: string | null;
          scheduled_start_at?: string | null;
          scheduled_time_zone?: string | null;
          start_date?: string | null;
          status?: string;
          task_number?: never;
          title?: string;
          updated_at?: string;
          version?: number;
          workspace_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'tr8_tasks_workspace_project_fk';
            columns: ['workspace_id', 'project_id'];
            isOneToOne: false;
            referencedRelation: 'tr8_workspace_projects';
            referencedColumns: ['workspace_id', 'id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      tr8_v2_accept_invitation: { Args: { p_token: string }; Returns: Json };
      tr8_v2_assign_task: {
        Args: {
          p_assignee_member_id: string;
          p_id: string;
          p_version: number;
          p_workspace_id: string;
        };
        Returns: {
          assignee_member_id: string | null;
          created_at: string;
          description: string;
          due_date: string | null;
          id: string;
          owner_id: string;
          position: number;
          priority: string;
          project_id: string;
          scheduled_end_at: string | null;
          scheduled_start_at: string | null;
          scheduled_time_zone: string | null;
          start_date: string | null;
          status: string;
          task_number: number;
          title: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'tr8_workspace_tasks';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      tr8_v2_create_invitation: {
        Args: { p_email: string; p_id: string; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_create_project: {
        Args: {
          p_color: string;
          p_description: string;
          p_id: string;
          p_name: string;
          p_status: string;
          p_workspace_id: string;
        };
        Returns: {
          archived_at: string | null;
          code: string | null;
          color: string;
          created_at: string;
          description: string;
          id: string;
          name: string;
          owner_id: string;
          status: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'tr8_workspace_projects';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      tr8_v2_create_role: {
        Args: {
          p_id: string;
          p_name: string;
          p_permissions: string[];
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_create_task: {
        Args: {
          p_description: string;
          p_due_date: string;
          p_id: string;
          p_priority: string;
          p_project_id: string;
          p_start_date: string;
          p_status: string;
          p_title: string;
          p_workspace_id: string;
        };
        Returns: {
          assignee_member_id: string | null;
          created_at: string;
          description: string;
          due_date: string | null;
          id: string;
          owner_id: string;
          position: number;
          priority: string;
          project_id: string;
          scheduled_end_at: string | null;
          scheduled_start_at: string | null;
          scheduled_time_zone: string | null;
          start_date: string | null;
          status: string;
          task_number: number;
          title: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'tr8_workspace_tasks';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      tr8_v2_create_team: {
        Args: { p_id: string; p_name: string };
        Returns: Json;
      };
      tr8_v2_delete_role: {
        Args: { p_id: string; p_version: number; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_delete_task: {
        Args: { p_id: string; p_version: number; p_workspace_id: string };
        Returns: undefined;
      };
      tr8_v2_get_calendar_preferences: { Args: never; Returns: Json };
      tr8_v2_get_context: { Args: never; Returns: Json };
      tr8_v2_get_project_capabilities: {
        Args: { p_project_id: string; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_list_activity: {
        Args: {
          p_before_id?: number;
          p_limit?: number;
          p_project_id?: string;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_list_assignable_members: {
        Args: {
          p_cursor?: string;
          p_limit?: number;
          p_project_id: string;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_list_calendar: {
        Args: {
          p_assignee_member_ids?: string[];
          p_cursor?: string;
          p_date_from: string;
          p_date_to: string;
          p_include_archived?: boolean;
          p_limit?: number;
          p_mine?: boolean;
          p_project_ids?: string[];
          p_statuses?: string[];
          p_time_zone: string;
          p_workspace_ids: string[];
        };
        Returns: Json;
      };
      tr8_v2_list_invitations: {
        Args: { p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_list_members: { Args: { p_workspace_id: string }; Returns: Json };
      tr8_v2_list_members_page: {
        Args: { p_cursor?: string; p_limit?: number; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_list_project_access: {
        Args: {
          p_cursor?: string;
          p_limit?: number;
          p_project_id: string;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_list_project_capabilities: {
        Args: { p_cursor?: string; p_limit?: number; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_list_roles: {
        Args: { p_cursor?: string; p_limit?: number; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_list_unscheduled: {
        Args: {
          p_assignee_member_ids?: string[];
          p_cursor?: string;
          p_include_archived?: boolean;
          p_limit?: number;
          p_mine?: boolean;
          p_project_ids?: string[];
          p_statuses?: string[];
          p_workspace_ids: string[];
        };
        Returns: Json;
      };
      tr8_v2_remove_member: {
        Args: { p_member_id: string; p_version: number; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_remove_project_access: {
        Args: {
          p_member_id: string;
          p_project_id: string;
          p_version: number;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_revoke_invitation: {
        Args: { p_id: string; p_version: number; p_workspace_id: string };
        Returns: Json;
      };
      tr8_v2_schedule_task: {
        Args: {
          p_id: string;
          p_scheduled_end_at: string;
          p_scheduled_start_at: string;
          p_scheduled_time_zone: string;
          p_version: number;
          p_workspace_id: string;
        };
        Returns: {
          assignee_member_id: string | null;
          created_at: string;
          description: string;
          due_date: string | null;
          id: string;
          owner_id: string;
          position: number;
          priority: string;
          project_id: string;
          scheduled_end_at: string | null;
          scheduled_start_at: string | null;
          scheduled_time_zone: string | null;
          start_date: string | null;
          status: string;
          task_number: number;
          title: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'tr8_workspace_tasks';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      tr8_v2_set_calendar_preferences: {
        Args: { p_time_zone: string; p_version: number };
        Returns: Json;
      };
      tr8_v2_set_member_roles: {
        Args: {
          p_member_id: string;
          p_role_ids: string[];
          p_version: number;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_set_project_access: {
        Args: {
          p_access_level: string;
          p_member_id: string;
          p_project_id: string;
          p_version: number;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_update_project: {
        Args: {
          p_id: string;
          p_patch: Json;
          p_version: number;
          p_workspace_id: string;
        };
        Returns: {
          archived_at: string | null;
          code: string | null;
          color: string;
          created_at: string;
          description: string;
          id: string;
          name: string;
          owner_id: string;
          status: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'tr8_workspace_projects';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      tr8_v2_update_role: {
        Args: {
          p_id: string;
          p_name: string;
          p_permissions: string[];
          p_version: number;
          p_workspace_id: string;
        };
        Returns: Json;
      };
      tr8_v2_update_task: {
        Args: {
          p_id: string;
          p_patch: Json;
          p_version: number;
          p_workspace_id: string;
        };
        Returns: {
          assignee_member_id: string | null;
          created_at: string;
          description: string;
          due_date: string | null;
          id: string;
          owner_id: string;
          position: number;
          priority: string;
          project_id: string;
          scheduled_end_at: string | null;
          scheduled_start_at: string | null;
          scheduled_time_zone: string | null;
          start_date: string | null;
          status: string;
          task_number: number;
          title: string;
          updated_at: string;
          version: number;
          workspace_id: string;
        };
        SetofOptions: {
          from: '*';
          to: 'tr8_workspace_tasks';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views']) | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
