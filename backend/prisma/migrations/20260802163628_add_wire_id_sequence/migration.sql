-- Wire command IDs: the numeric id sent to the device as C:<id>:<command>.
-- A fresh id is drawn per SEND ATTEMPT (not per row), so a late devicecmd
-- reply to a previous attempt can never be mis-correlated with the current
-- one. DB-backed so ids survive restarts; cycling is fine — correlation only
-- needs uniqueness across the in-flight window, not forever.
CREATE SEQUENCE IF NOT EXISTS "sync_command_wire_id_seq"
  AS integer
  START WITH 1
  CYCLE;
