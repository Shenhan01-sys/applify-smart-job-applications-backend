#!/usr/bin/env node
// ============================================================================
// Applify — Verify 10 Dummy Users (UAT)
// ============================================================================
// Membaca 10 user dari Supabase dan menampilkan ringkasan data lengkap:
// profiles, work_experiences, education, user_skills, automation_settings,
// subscriptions.
// ============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY dulu.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function verify() {
  const results = [];
  for (let i = 1; i <= 10; i++) {
    const email = `user${String(i).padStart(3, '0')}@example.com`;
    const { data: authUsers } = await admin.auth.admin.listUsers({ 
      page: 1, 
      perPage: 1000,
      email: email
    });
    const authUser = authUsers?.users?.find(u => u.email === email);
    if (!authUser) {
      console.log(`\n❌ ${email} — TIDAK DITEMUKAN di Auth`);
      continue;
    }

    const userId = authUser.id;

    const [
      profileRes,
      workRes,
      eduRes,
      skillsRes,
      settingsRes,
      subRes,
      appsRes,
      approvalRes
    ] = await Promise.all([
      admin.from("profiles").select("*").eq("id", userId).single(),
      admin.from("work_experiences").select("*").eq("user_id", userId),
      admin.from("education").select("*").eq("user_id", userId),
      admin.from("user_skills").select("*").eq("user_id", userId),
      admin.from("user_automation_settings").select("*").eq("user_id", userId).single(),
      admin.from("subscriptions").select("*").eq("user_id", userId).single(),
      admin.from("ai_applications").select("*", { count: "exact", head: true }).eq("user_id", userId),
      admin.from("approval_requests").select("*", { count: "exact", head: true }).eq("user_id", userId),
    ]);

    const profile = profileRes.data;
    const work = workRes.data || [];
    const edu = eduRes.data || [];
    const skills = skillsRes.data || [];
    const settings = settingsRes.data;
    const sub = subRes.data;

    results.push({
      email,
      userId,
      profile,
      workCount: work.length,
      eduCount: edu.length,
      skillsCount: skills.length,
      skills: skills.map(s => s.name).join(", "),
      settings,
      sub,
      aiAppCount: appsRes.count || 0,
      approvalCount: approvalRes.count || 0,
    });
  }

  console.log("\n=== VERIFIKASI 10 DUMMY USERS ===\n");
  for (const r of results) {
    console.log(`📧 ${r.email}`);
    console.log(`   ID: ${r.userId}`);
    console.log(`   Profile: ${r.profile?.current_title || 'N/A'} | ${r.profile?.industry || 'N/A'}`);
    console.log(`   Skills (${r.skillsCount}): ${r.skills || 'N/A'}`);
    console.log(`   Work experiences: ${r.workCount} | Education: ${r.eduCount}`);
    console.log(`   Automation settings: pause=${r.settings?.pause_before_submit} | model=${r.settings?.ai_model}`);
    console.log(`   Subscription: ${r.sub?.plan_name || 'N/A'} (${r.sub?.status || 'N/A'})`);
    console.log(`   Applications: ${r.aiAppCount} | Approval requests: ${r.approvalCount}`);
    console.log("");
  }

  // Summary
  const totalSkills = results.reduce((sum, r) => sum + r.skillsCount, 0);
  const totalWork = results.reduce((sum, r) => sum + r.workCount, 0);
  const totalEdu = results.reduce((sum, r) => sum + r.eduCount, 0);
  console.log("=== SUMMARY ===");
  console.log(`Total users verified: ${results.length}`);
  console.log(`Total skills: ${totalSkills} (avg ${(totalSkills / results.length).toFixed(1)} per user)`);
  console.log(`Total work experiences: ${totalWork} (avg ${(totalWork / results.length).toFixed(1)} per user)`);
  console.log(`Total education: ${totalEdu} (avg ${(totalEdu / results.length).toFixed(1)} per user)`);
}

verify().catch(e => { console.error(e); process.exit(1); });
