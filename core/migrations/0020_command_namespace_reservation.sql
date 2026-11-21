-- Empty on creation: existing attempts and transport IDs have no proven shared history.
-- Reservations are permanent; future integration must reserve in the same transaction
-- as the owning attempt and resolve legacy IDs before enabling the shared namespace.
-- SMS and call attempt tables, DeviceCommands, hello.ok and ACK allocators do not
-- consult this table. Historical absence cannot be established by this table.
CREATE TABLE command_namespace_reservation (
  command_id text COLLATE "C" PRIMARY KEY CHECK (command_id <> ''),
  command_type text COLLATE "C" NOT NULL CHECK (command_type <> ''),
  owner_type text COLLATE "C" NOT NULL CHECK (owner_type <> ''),
  owner_id text COLLATE "C" NOT NULL CHECK (owner_id <> ''),
  device_id text COLLATE "C" NOT NULL CHECK (device_id <> ''),
  created_at timestamptz NOT NULL DEFAULT now()
);
