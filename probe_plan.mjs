#!/usr/bin/env node
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: lu } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const demo = (lu.users || []).find((u) => u.email && u.email.endsWith("@example.com"));
if (!demo) { console.log("no demo user"); process.exit(0); }
const plans = [
  { plan_name: "Free", ai_model_tier: "free" },
  { plan_name: "Pro", ai_model_tier: "pro" },
  { plan_name: "Annual", ai_model_tier: "pro" },
];
for (const p of plans) {
  const { error } = await admin.from("subscriptions").upsert({ user_id: demo.id, ...p, status: "active", monthly_quota: 10, used_quota: 0, daily_apply_quota: 10 });
  console.log(JSON.stringify(p), error ? "REJECT " + error.message : "ALLOW");
}
