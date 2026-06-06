import { getServiceClient, authEmail, cors, mapProfile } from './_lib/supabase.js';

const REFERRAL_REWARD = 30;

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabase = getServiceClient();
    const {
      name, username, phone, password,
      activationCode, referralUsername
    } = req.body || {};

    const uname = (username || '').toLowerCase().trim();
    const phoneNum = (phone || '').replace(/\s/g, '');
    const code = (activationCode || '').toUpperCase().trim();
    const refUser = (referralUsername || '').toLowerCase().trim();

    if (!name || name.length < 2) return res.status(400).json({ error: 'Enter your complete name' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname)) return res.status(400).json({ error: 'Invalid username' });
    if (!/^09\d{9}$/.test(phoneNum)) return res.status(400).json({ error: 'Invalid phone number' });
    if (!code) return res.status(400).json({ error: 'Activation code required' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const { data: existingUser } = await supabase.from('profiles').select('id').eq('username', uname).maybeSingle();
    if (existingUser) return res.status(400).json({ error: 'Username already taken' });

    const { data: existingPhone } = await supabase.from('profiles').select('id').eq('phone', phoneNum).maybeSingle();
    if (existingPhone) return res.status(400).json({ error: 'Phone number already registered' });

    const { data: actCode } = await supabase.from('activation_codes').select('*').eq('code_id', code).maybeSingle();
    if (!actCode) return res.status(400).json({ error: 'Invalid activation code' });
    if (actCode.status === 'disabled') return res.status(400).json({ error: 'Activation code is disabled' });
    if (actCode.status === 'used') return res.status(400).json({ error: 'Activation code already used' });

    let referrer = null;
    if (refUser) {
      const { data: ref } = await supabase.from('profiles').select('*').eq('username', refUser).eq('role', 'user').maybeSingle();
      if (!ref) return res.status(400).json({ error: 'Referral username not found' });
      if (ref.username === uname) return res.status(400).json({ error: 'Cannot refer yourself' });
      referrer = ref;
    }

    const email = authEmail(uname);
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username: uname, name }
    });

    if (authError) return res.status(400).json({ error: authError.message });

    const userId = authData.user.id;

    const { data: profile, error: profileError } = await supabase.from('profiles').insert({
      id: userId,
      name,
      username: uname,
      phone: phoneNum,
      role: 'user',
      status: 'active',
      activation_code: code,
      referred_by: referrer ? referrer.username : null
    }).select().single();

    if (profileError) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(400).json({ error: profileError.message });
    }

    await supabase.from('activation_codes').update({
      status: 'used',
      user_assigned: uname
    }).eq('code_id', code);

    if (referrer) {
      const { data: existingRef } = await supabase.from('referrals')
        .select('id').eq('referred_username', uname).maybeSingle();

      if (!existingRef) {
        await supabase.from('profiles').update({
          referral_earnings: parseFloat(referrer.referral_earnings) + REFERRAL_REWARD,
          referral_count: referrer.referral_count + 1,
          earnings: parseFloat(referrer.earnings) + REFERRAL_REWARD,
          updated_at: new Date().toISOString()
        }).eq('id', referrer.id);

        await supabase.from('referrals').insert({
          referrer_id: referrer.id,
          referred_id: userId,
          referrer_username: referrer.username,
          referred_username: uname,
          reward: REFERRAL_REWARD
        });

        await supabase.from('earnings').insert({
          user_id: referrer.id,
          username: referrer.username,
          amount: REFERRAL_REWARD,
          type: 'referral',
          description: `Referral bonus for ${uname}`
        });

        await supabase.from('notifications').insert({
          user_id: referrer.id,
          message: `You earned ₱${REFERRAL_REWARD.toFixed(2)} from referral ${uname}!`,
          type: 'success'
        });
      }
    }

    await supabase.from('notifications').insert({
      user_id: userId,
      message: 'Welcome to MathBOT! Start solving math to earn.',
      type: 'success'
    });

    await supabase.from('admin_logs').insert({
      action: 'USER_REGISTERED',
      details: `New user: ${uname}`,
      admin_username: 'system'
    });

    return res.status(201).json({ success: true, user: mapProfile(profile) });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Registration failed' });
  }
}
