import { getServiceClient, cors } from './_lib/supabase.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const token = authHeader.slice(7);
    const supabase = getServiceClient();

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Invalid session' });

    const { data: admin } = await supabase.from('profiles').select('role').eq('id', user.id).single();
    if (!admin || admin.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    const { data: target } = await supabase.from('profiles').select('username, role').eq('id', userId).single();
    if (!target || target.role === 'admin') return res.status(400).json({ error: 'Cannot delete this user' });

    const { error: delError } = await supabase.auth.admin.deleteUser(userId);
    if (delError) return res.status(400).json({ error: delError.message });

    await supabase.from('admin_logs').insert({
      action: 'USER_DELETED',
      details: target.username,
      admin_username: user.user_metadata?.username || 'admin'
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
