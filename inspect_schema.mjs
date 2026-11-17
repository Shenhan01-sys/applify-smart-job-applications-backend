#!/usr/bin/env node
// Applify - inspect live DB schema for key tables (read-only).
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const tables = ["profiles", "work_experiences", "education", "user_skills", "user_automation_settings", "subscriptions"];
for (const t of tables) {
  const { data, error } = await admin
    .from("information_schema.columns")
    .select("table_name,column_name,data_type,is_nullable,column_default")
    .eq("table_name", t);
  if (error) { console.log(`\n[${t}] info_schema error:`, error.message); continue; }
  console.log(`\n[${t}]`);
  for (const c of data) {
    console.log(`  ${c.column_name}  ${c.data_type}  null=${c.is_nullable}  default=${c.column_default ?? "-"}`);
  }
}
