-- MathBOT Supabase PostgreSQL Schema
-- Run this in Supabase SQL Editor

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  earnings DECIMAL(12, 4) NOT NULL DEFAULT 0,
  referral_earnings DECIMAL(12, 4) NOT NULL DEFAULT 0,
  total_withdrawn DECIMAL(12, 4) NOT NULL DEFAULT 0,
  referral_count INT NOT NULL DEFAULT 0,
  total_answered INT NOT NULL DEFAULT 0,
  correct_answers INT NOT NULL DEFAULT 0,
  wrong_answers INT NOT NULL DEFAULT 0,
  activation_code TEXT,
  referred_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activation_codes (
  code_id TEXT PRIMARY KEY,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used', 'disabled')),
  user_assigned TEXT,
  value DECIMAL(10, 2) NOT NULL DEFAULT 159
);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referrer_username TEXT NOT NULL,
  referred_username TEXT NOT NULL UNIQUE,
  reward DECIMAL(12, 4) NOT NULL DEFAULT 30,
  rewarded BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  amount DECIMAL(12, 4) NOT NULL,
  gcash_number TEXT NOT NULL,
  gcash_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS earnings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  amount DECIMAL(12, 4) NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('game', 'referral')),
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS question_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, question_key)
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info', 'success', 'warning', 'error')),
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  action TEXT NOT NULL,
  details TEXT,
  admin_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_earnings_created ON earnings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_earnings_user ON earnings(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_question_history_user ON question_history(user_id);

-- ============================================================
-- HELPERS
-- ============================================================

CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin' AND status = 'active'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION get_my_profile()
RETURNS profiles AS $$
  SELECT * FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION auth_email_for_username(p_username TEXT)
RETURNS TEXT AS $$
  SELECT lower(trim(p_username)) || '@mathbot.app';
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION add_notification(
  p_user_id UUID, p_message TEXT, p_type TEXT DEFAULT 'info'
) RETURNS VOID AS $$
BEGIN
  INSERT INTO notifications (user_id, message, type)
  VALUES (p_user_id, p_message, p_type);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION log_admin_action(p_action TEXT, p_details TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE v_admin TEXT;
BEGIN
  SELECT username INTO v_admin FROM profiles WHERE id = auth.uid();
  INSERT INTO admin_logs (action, details, admin_username)
  VALUES (p_action, p_details, COALESCE(v_admin, 'system'));
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- GAME & WITHDRAWALS (user RPCs)
-- ============================================================

CREATE OR REPLACE FUNCTION submit_game_answer(
  p_question_key TEXT,
  p_user_answer NUMERIC,
  p_correct_answer NUMERIC
) RETURNS JSON AS $$
DECLARE
  v_user profiles%ROWTYPE;
  v_correct BOOLEAN;
  v_reward DECIMAL(12,4) := 0.02;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_user FROM profiles WHERE id = auth.uid();
  IF v_user.status = 'banned' THEN
    RAISE EXCEPTION 'Account banned';
  END IF;

  INSERT INTO question_history (user_id, question_key)
  VALUES (auth.uid(), p_question_key)
  ON CONFLICT (user_id, question_key) DO NOTHING;

  v_correct := ABS(p_user_answer - p_correct_answer) < 0.001;

  UPDATE profiles SET
    total_answered = total_answered + 1,
    correct_answers = correct_answers + CASE WHEN v_correct THEN 1 ELSE 0 END,
    wrong_answers = wrong_answers + CASE WHEN v_correct THEN 0 ELSE 1 END,
    earnings = earnings + CASE WHEN v_correct THEN v_reward ELSE 0 END,
    updated_at = NOW()
  WHERE id = auth.uid()
  RETURNING * INTO v_user;

  IF v_correct THEN
    INSERT INTO earnings (user_id, username, amount, type, description)
    VALUES (auth.uid(), v_user.username, v_reward, 'game', 'Correct answer');
  END IF;

  RETURN json_build_object(
    'correct', v_correct,
    'reward', CASE WHEN v_correct THEN v_reward ELSE 0 END,
    'correctAnswer', p_correct_answer,
    'profile', row_to_json(v_user)
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION request_withdrawal(
  p_amount DECIMAL,
  p_gcash_name TEXT,
  p_gcash_number TEXT
) RETURNS JSON AS $$
DECLARE
  v_user profiles%ROWTYPE;
  v_pending DECIMAL;
  v_available DECIMAL;
  v_min DECIMAL := 100;
  v_wd withdrawals%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  SELECT * INTO v_user FROM profiles WHERE id = auth.uid();
  IF v_user.status = 'banned' THEN RAISE EXCEPTION 'Account banned'; END IF;
  IF p_amount < v_min THEN RAISE EXCEPTION 'Minimum withdrawal is 100'; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_pending
  FROM withdrawals WHERE user_id = auth.uid() AND status = 'pending';

  v_available := v_user.earnings + v_user.referral_earnings - v_user.total_withdrawn - v_pending;
  IF p_amount > v_available THEN RAISE EXCEPTION 'Insufficient balance'; END IF;

  INSERT INTO withdrawals (user_id, username, amount, gcash_number, gcash_name)
  VALUES (auth.uid(), v_user.username, p_amount, p_gcash_number, p_gcash_name)
  RETURNING * INTO v_wd;

  PERFORM add_notification(auth.uid(),
    'Withdrawal of ₱' || p_amount::TEXT || ' submitted — pending review', 'info');

  RETURN row_to_json(v_wd);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION mark_notifications_read()
RETURNS VOID AS $$
BEGIN
  UPDATE notifications SET read = TRUE
  WHERE user_id = auth.uid() AND read = FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- ADMIN RPCs
-- ============================================================

CREATE OR REPLACE FUNCTION admin_generate_codes(p_count INT DEFAULT 1)
RETURNS JSON AS $$
DECLARE
  v_chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code TEXT;
  v_i INT;
  v_j INT;
  v_k INT;
  v_seg TEXT;
  v_inserted INT := 0;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  p_count := LEAST(GREATEST(p_count, 1), 50);

  FOR v_i IN 1..p_count LOOP
    v_code := 'MB';
    FOR v_k IN 1..3 LOOP
      v_seg := '';
      FOR v_j IN 1..4 LOOP
        v_seg := v_seg || substr(v_chars, (floor(random() * length(v_chars)) + 1)::INT, 1);
      END LOOP;
      v_code := v_code || '-' || v_seg;
    END LOOP;

    BEGIN
      INSERT INTO activation_codes (code_id) VALUES (v_code);
      v_inserted := v_inserted + 1;
    EXCEPTION WHEN unique_violation THEN
      NULL;
    END;
  END LOOP;

  PERFORM log_admin_action('CODES_GENERATED', p_count::TEXT);
  RETURN json_build_object('generated', v_inserted);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION admin_disable_code(p_code_id TEXT)
RETURNS VOID AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  UPDATE activation_codes SET status = 'disabled'
  WHERE code_id = p_code_id AND status = 'unused';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION admin_delete_code(p_code_id TEXT)
RETURNS VOID AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  DELETE FROM activation_codes WHERE code_id = p_code_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION admin_update_user(
  p_user_id UUID,
  p_name TEXT,
  p_phone TEXT,
  p_earnings DECIMAL
) RETURNS VOID AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  UPDATE profiles SET
    name = p_name,
    phone = p_phone,
    earnings = p_earnings,
    updated_at = NOW()
  WHERE id = p_user_id AND role = 'user';
  PERFORM log_admin_action('USER_EDITED', p_user_id::TEXT);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION admin_toggle_ban(p_user_id UUID)
RETURNS TEXT AS $$
DECLARE v_status TEXT;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  UPDATE profiles SET
    status = CASE WHEN status = 'banned' THEN 'active' ELSE 'banned' END,
    updated_at = NOW()
  WHERE id = p_user_id AND role = 'user'
  RETURNING status INTO v_status;
  PERFORM log_admin_action('USER_BAN', v_status);
  RETURN v_status;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION admin_process_withdrawal(
  p_withdrawal_id UUID,
  p_status TEXT
) RETURNS JSON AS $$
DECLARE
  v_wd withdrawals%ROWTYPE;
  v_user profiles%ROWTYPE;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admin only'; END IF;
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid status';
  END IF;

  SELECT * INTO v_wd FROM withdrawals WHERE id = p_withdrawal_id AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Withdrawal not found or already processed'; END IF;

  UPDATE withdrawals SET status = p_status, processed_at = NOW()
  WHERE id = p_withdrawal_id RETURNING * INTO v_wd;

  SELECT * INTO v_user FROM profiles WHERE id = v_wd.user_id;

  IF p_status = 'approved' THEN
    UPDATE profiles SET total_withdrawn = total_withdrawn + v_wd.amount, updated_at = NOW()
    WHERE id = v_wd.user_id;
    PERFORM add_notification(v_wd.user_id,
      'Withdrawal of ₱' || v_wd.amount::TEXT || ' approved!', 'success');
    PERFORM log_admin_action('WD_APPROVED', v_user.username || ' ₱' || v_wd.amount::TEXT);
  ELSE
    PERFORM add_notification(v_wd.user_id,
      'Withdrawal of ₱' || v_wd.amount::TEXT || ' was rejected. Balance restored.', 'error');
    PERFORM log_admin_action('WD_REJECTED', v_user.username || ' ₱' || v_wd.amount::TEXT);
  END IF;

  RETURN row_to_json(v_wd);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- VIEWS FOR LEADERBOARDS
-- ============================================================

CREATE OR REPLACE VIEW daily_earnings_leaderboard AS
SELECT username, SUM(amount) AS total
FROM earnings
WHERE created_at >= CURRENT_DATE
GROUP BY username
ORDER BY total DESC
LIMIT 10;

CREATE OR REPLACE VIEW top_earners_leaderboard AS
SELECT username, (earnings + referral_earnings) AS total
FROM profiles
WHERE role = 'user' AND status = 'active'
ORDER BY total DESC
LIMIT 10;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE earnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- Profiles
CREATE POLICY "Users read own profile" ON profiles FOR SELECT
  USING (auth.uid() = id OR is_admin());
CREATE POLICY "Public read usernames for referral check" ON profiles FOR SELECT
  USING (role = 'user');
CREATE POLICY "Admin update profiles" ON profiles FOR UPDATE
  USING (is_admin());

-- Activation codes (admin full, users read unused for validation via API)
CREATE POLICY "Admin manage codes" ON activation_codes FOR ALL
  USING (is_admin());
CREATE POLICY "Anyone read codes" ON activation_codes FOR SELECT
  USING (TRUE);

-- Referrals
CREATE POLICY "Users read own referrals" ON referrals FOR SELECT
  USING (referrer_id = auth.uid() OR referred_id = auth.uid() OR is_admin());
CREATE POLICY "Admin manage referrals" ON referrals FOR ALL
  USING (is_admin());

-- Withdrawals
CREATE POLICY "Users read own withdrawals" ON withdrawals FOR SELECT
  USING (user_id = auth.uid() OR is_admin());
CREATE POLICY "Admin manage withdrawals" ON withdrawals FOR ALL
  USING (is_admin());

-- Earnings (public leaderboard + own)
CREATE POLICY "Read earnings" ON earnings FOR SELECT USING (TRUE);
CREATE POLICY "Insert earnings via RPC" ON earnings FOR INSERT
  WITH CHECK (auth.uid() = user_id OR is_admin());

-- Question history
CREATE POLICY "Users own question history" ON question_history FOR ALL
  USING (user_id = auth.uid() OR is_admin());

-- Notifications
CREATE POLICY "Users own notifications" ON notifications FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY "Users update own notifications" ON notifications FOR UPDATE
  USING (user_id = auth.uid());

-- Admin logs
CREATE POLICY "Admin read logs" ON admin_logs FOR SELECT
  USING (is_admin());

-- ============================================================
-- REALTIME
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE withdrawals;
ALTER PUBLICATION supabase_realtime ADD TABLE earnings;
ALTER PUBLICATION supabase_realtime ADD TABLE activation_codes;
ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

-- ============================================================
-- SEED DEMO ACTIVATION CODES
-- ============================================================

INSERT INTO activation_codes (code_id, status, value) VALUES
  ('MB-DEMO-CODE-0001', 'unused', 159),
  ('MB-DEMO-CODE-0002', 'unused', 159),
  ('MB-DEMO-CODE-0003', 'unused', 159)
ON CONFLICT (code_id) DO NOTHING;

-- Grant RPC access to authenticated users
GRANT EXECUTE ON FUNCTION submit_game_answer TO authenticated;
GRANT EXECUTE ON FUNCTION request_withdrawal TO authenticated;
GRANT EXECUTE ON FUNCTION mark_notifications_read TO authenticated;
GRANT EXECUTE ON FUNCTION admin_generate_codes TO authenticated;
GRANT EXECUTE ON FUNCTION admin_disable_code TO authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_code TO authenticated;
GRANT EXECUTE ON FUNCTION admin_update_user TO authenticated;
GRANT EXECUTE ON FUNCTION admin_toggle_ban TO authenticated;
GRANT EXECUTE ON FUNCTION admin_process_withdrawal TO authenticated;
GRANT EXECUTE ON FUNCTION is_admin TO authenticated;
