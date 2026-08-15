import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "缺少 Supabase 环境变量：请检查 VITE_SUPABASE_URL 和 VITE_SUPABASE_PUBLISHABLE_KEY 是否已配置。"
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
