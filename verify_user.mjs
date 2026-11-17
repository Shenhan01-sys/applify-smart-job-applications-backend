#!/usr/bin/env node
// Applify - verify a demo user's subscription row source.
import { createClient } from "@supabase/supabase-js";

const email = process.argv[2] || "user001@example.com";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: lu } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
const au = (lu.users || []).find((x) => x.email === email);
if (!au) { console.error("not found:", email); process.exit(1); }

const { data: sub, error } = await admin.from("subscriptions").select("*").eq("user_id", au.id).maybeSingle();
console.log("subscription for", email, ":", error ? "ERR " + error.message : JSON.stringify(sub, null, 2));
