import { createClient } from "@supabase/supabase-js";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

async function check() {
  const { data: authUsers } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const users = authUsers?.users || [];
  const dummyUsers = users.filter(u => u.email && u.email.endsWith("@example.com"));
  console.log("Dummy auth users:", dummyUsers.length);
  
  const { data: profiles } = await admin.from("profiles").select("id, full_name, current_title, skills");
  const dummyProfiles = (profiles || []).filter(p => dummyUsers.some(u => u.id === p.id));
  console.log("Dummy profiles found:", dummyProfiles.length);
  
  // Check specific dummy users
  const uids = dummyUsers.slice(0, 5).map(u => u.id);
  const { data: existingProfiles } = await admin.from("profiles").select("id, full_name").in("id", uids);
  console.log("Existing profiles for first 5 dummy users:", JSON.stringify(existingProfiles, null, 2));
  
  // Also check total profiles count
  const { count: totalProfiles } = await admin.from("profiles").select("*", { count: "exact", head: true });
  console.log("Total profiles in DB:", totalProfiles);
  
  if (dummyProfiles.length > 0) {
    console.log("Sample dummy profiles:", JSON.stringify(dummyProfiles.slice(0, 3), null, 2));
  } else {
    console.log("NO dummy profiles found in profiles table!");
    
    // Check if they exist in other tables
    const uids = dummyUsers.slice(0, 5).map(u => u.id);
    const { data: skills } = await admin.from("user_skills").select("user_id, name").in("user_id", uids);
    console.log("Dummy users with skills:", skills?.length || 0);
    
    const { data: work } = await admin.from("work_experiences").select("user_id, role_title").in("user_id", uids);
    console.log("Dummy users with work exp:", work?.length || 0);
  }
}
check().catch(e => console.error(e));