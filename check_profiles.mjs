import { createClient } from "@supabase/supabase-js";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function check() {
  const { count } = await admin.from("profiles").select("*", { count: "exact", head: true });
  console.log("Total profiles in DB:", count);

  const { data } = await admin.from("profiles").select("*").limit(5);
  console.log("Sample profiles:", JSON.stringify(data, null, 2));
}
check().catch(e => console.error(e));
