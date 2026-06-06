import { getServiceClient, authEmail, cors } from './_lib/supabase.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.SETUP_SECRET;
  if (secret && req.headers['x-setup-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const supabase = getServiceClient();
    const results = { migrated: {}, errors: [] };
    const dbPath = join(process.cwd(), 'database');

    function readJson(file) {
      const p = join(dbPath, file);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, 'utf8'));
    }

    const codes = readJson('activation_codes.json');
    if (codes?.codes?.length) {
      const rows = codes.codes.map(c => ({
        code_id: c.id,
        generated_at: c.generatedDate,
        status: c.status,
        user_assigned: c.userAssigned,
        value: c.value || 159
      }));
      const { error } = await supabase.from('activation_codes').upsert(rows, { onConflict: 'code_id' });
      results.migrated.activation_codes = error ? 0 : rows.length;
      if (error) results.errors.push(error.message);
    }

    const users = readJson('users.json');
    if (users?.users?.length) {
      let count = 0;
      for (const u of users.users) {
        if (u.username === 'admin') continue;
        const { data: exists } = await supabase.from('profiles').select('id').eq('username', u.username).maybeSingle();
        if (exists) continue;

        const email = authEmail(u.username);
        const tempPass = 'migrate123';
        const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
          email, password: tempPass, email_confirm: true,
          user_metadata: { username: u.username, migrated: true }
        });
        if (authErr) { results.errors.push(`${u.username}: ${authErr.message}`); continue; }

        await supabase.from('profiles').insert({
          id: authData.user.id,
          name: u.name,
          username: u.username,
          phone: u.phone,
          role: u.role || 'user',
          status: u.status || 'active',
          earnings: u.earnings || 0,
          referral_earnings: u.referralEarnings || 0,
          total_withdrawn: u.totalWithdrawn || 0,
          referral_count: u.referralCount || 0,
          total_answered: u.stats?.totalAnswered || 0,
          correct_answers: u.stats?.correct || 0,
          wrong_answers: u.stats?.wrong || 0,
          activation_code: u.activationCode,
          referred_by: u.referredBy,
          created_at: u.registrationDate || new Date().toISOString()
        });
        count++;
      }
      results.migrated.users = count;
      results.note = 'Migrated users have temporary password: migrate123';
    }

    const earnings = readJson('earnings.json');
    if (earnings?.earnings?.length) {
      const rows = [];
      for (const e of earnings.earnings) {
        const { data: prof } = await supabase.from('profiles').select('id').eq('username', e.username).maybeSingle();
        if (prof) {
          rows.push({
            user_id: prof.id,
            username: e.username,
            amount: e.amount,
            type: e.type,
            description: e.description,
            created_at: e.date
          });
        }
      }
      if (rows.length) {
        const { error } = await supabase.from('earnings').insert(rows);
        results.migrated.earnings = error ? 0 : rows.length;
        if (error) results.errors.push(error.message);
      }
    }

    const withdrawals = readJson('withdrawals.json');
    if (withdrawals?.withdrawals?.length) {
      let count = 0;
      for (const w of withdrawals.withdrawals) {
        let { data: prof } = await supabase.from('profiles').select('id, username').eq('username', w.username).maybeSingle();
        if (!prof && w.userId) {
          const r = await supabase.from('profiles').select('id, username').eq('id', w.userId).maybeSingle();
          prof = r.data;
        }
        if (!prof) continue;
        await supabase.from('withdrawals').insert({
          user_id: prof.id,
          username: w.username || prof.username,
          amount: w.amount,
          gcash_number: w.gcashNumber,
          gcash_name: w.gcashName,
          status: w.status,
          requested_at: w.dateRequested,
          processed_at: w.processedDate
        });
        count++;
      }
      results.migrated.withdrawals = count;
    }

    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
