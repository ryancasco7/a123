import { getServiceClient, authEmail, cors } from './_lib/supabase.js';

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
    const email = authEmail('admin');

    const { data: existing } = await supabase.from('profiles').select('id').eq('username', 'admin').maybeSingle();
    if (existing) {
      return res.status(200).json({ message: 'Admin already exists', username: 'admin' });
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: 'admin123',
      email_confirm: true,
      user_metadata: { username: 'admin', name: 'System Administrator' }
    });

    if (authError) return res.status(400).json({ error: authError.message });

    await supabase.from('profiles').insert({
      id: authData.user.id,
      name: 'System Administrator',
      username: 'admin',
      phone: '09000000000',
      role: 'admin',
      status: 'active',
      activation_code: 'ADMIN'
    });

    return res.status(201).json({
      message: 'Admin created',
      username: 'admin',
      password: 'admin123'
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
