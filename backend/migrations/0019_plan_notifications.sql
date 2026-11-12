-- Notifikasi perubahan paket langganan: Premium (pengguna) dan Pro/Pro Unlimited (pemilik komunitas), aktif dan berakhir.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('community_invite', 'join_request', 'join_approved', 'run_invite', 'new_follower', 'post_like', 'post_comment', 'badge_earned',
                  'event_submission_approved', 'event_submission_rejected',
                  'session_new', 'session_cancelled', 'buddy_request', 'buddy_accepted', 'spot_approved', 'spot_rejected',
                  'kyc_approved', 'kyc_rejected', 'kyc_revoked',
                  'market_order_paid', 'market_order_shipped', 'market_order_completed', 'market_order_disputed', 'market_order_resolved',
                  'market_seller_live', 'market_listing_paid', 'banner_approved', 'banner_rejected',
                  'plan_activated', 'plan_ended', 'community_plan_activated', 'community_plan_ended'));
