import { createClient } from "@supabase/supabase-js";
import { requiredEnv } from "./server-config";

export function supabaseAdmin() {
  return createClient(
    requiredEnv("SUPABASE_URL"),
    requiredEnv("SUPABASE_SECRET_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}
