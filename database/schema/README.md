# Public database schema

The authoritative D1 schema is the ordered SQL in `database/migrations/`.

The public database contains only data safe for read-only observability. Provider credentials, raw model prompts, private chain-of-thought, VPS topology and broker data must never be written here.

