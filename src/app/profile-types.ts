export interface UserProfile {
  user_id: string;
  display_name: string;
  updated_at: string;
}

export interface ProfileApi {
  scopeKey: string[];
  load: (signal?: AbortSignal) => Promise<UserProfile>;
  save: (profile: UserProfile, name: string) => Promise<UserProfile>;
}
