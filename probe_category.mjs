#!/usr/bin/env node
// Applify - probe allowed values for user_skills.category by trial insert+delete.
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// use an existing demo user if any, otherwise create temp
const { data: lu } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const demo = (lu.users || []).find((u) => u.email && u.email.endsWith("@example.com"));
const uid = demo ? demo.id : undefined;

if (!uid) {
  console.log("no demo user found, skip probe (seed 1 user first)");
  process.exit(0);
}

const candidates = ["professional", "technical", "soft", "language", "tool", "framework", "other", "general"];
for (const c of candidates) {
  const { data, error } = await admin.from("user_skills").insert({
    user_id: uid, name: "probe-" + c, category: c, proficiency_level: 1, is_verified: false,
  }).select("id").maybeSingle();
  if (error) { console.log("REJECT", c, "->", error.message); continue; }
  if (data?.id) { console.log("ALLOW", c, "id", data.id); await admin.from("user_skills").delete().eq("id", data.id); }
}
