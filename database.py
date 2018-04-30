import psycopg2.extras
import config
import collections

postgres = psycopg2.connect(config.DATABASE_URI)

# Assumes that dict preserves insertion order (CPython 3.6+, other Python 3.7+, possible 3.5)
# Otherwise, tables might be created in the wrong order, breaking foreign key refs.
TABLES = {
	"users": [
		"twitchid integer primary key",
		"sched_timezone varchar not null default ''",
	],
	"setups": [
		"id serial primary key",
		"twitchid integer not null references mustard.users",
		"category text not null default ''",
		"title text not null default ''",
	],
	"communities": [
		"name text primary key",
		"twitchid text not null",
		"descr text not null default ''",
	],
	"setup_communities": [
		"setupid integer not null references mustard.setups on delete cascade",
		"community text not null references mustard.communities",
	],
}

def create_tables():
	with postgres, postgres.cursor() as cur:
		cur.execute("create schema if not exists mustard")
		cur.execute("""select table_name, column_name
				from information_schema.columns
				where table_schema = 'mustard'
				order by ordinal_position""")
		tables = collections.defaultdict(list)
		for table, column in cur:
			tables[table].append(column)
		for table, columns in TABLES.items():
			if table not in tables:
				# Table doesn't exist - create it. Yes, I'm using percent
				# interpolation, not parameterization. It's an unusual case.
				cur.execute("create table mustard.%s (%s)" % (
					table, ",".join(columns)))
			else:
				# Table exists. Check if all its columns do.
				# Note that we don't reorder columns. Removing works,
				# but inserting doesn't - new columns will be added at
				# the end of the table.
				want = {c.split()[0]: c for c in columns}
				have = tables[table]
				need = [c for c in want if c not in have]
				xtra = [c for c in have if c not in want]
				if not need and not xtra: continue # All's well!
				actions = ["add " + want[c] for c in need] + ["drop column " + c for c in xtra]
				cur.execute("alter table mustard." + table + " " + ", ".join(actions))
create_tables()

# Map community names to their IDs
# If a name is not present, look up the ID and cache it here.
_community_id = {}
def cache_community(community):
	"""Cache the info for a particular community.

	Saves both in memory and on disk. Assumes that it'll never change,
	which is a false assumption. This is one of the two hardest problems
	in computing, and I'm completely punting on it.
	"""
	_community_id[community["name"]] = community["_id"]
	args = (community["name"], community["summary"], community["_id"])
	with postgres, postgres.cursor() as cur:
		cur.execute("update mustard.communities set name=%s, descr=%s where twitchid=%s", args)
		if cur.rowcount: return
		cur.execute("insert into mustard.communities (name, descr, twitchid) values (%s, %s, %s)", args)

def get_community_id(name):
	return _community_id.get(name)

def create_user(twitchid):
	# TODO: Save the user's OAuth info, incl Twitter.
	try:
		with postgres, postgres.cursor() as cur:
			cur.execute("insert into mustard.users values (%s)", [twitchid])
	except psycopg2.IntegrityError:
		pass # TODO: Update any extra info eg Twitter OAuth

def create_setup(twitchid, category, title="", communities=(), **extra):
	"""Create a new 'setup' - a loadable stream config

	Returns the full record just created, including its ID.
	The communities MUST have already been stored in the on-disk cache.
	"""
	with postgres, postgres.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
		cur.execute("insert into mustard.setups (twitchid, category, title) values (%s, %s, %s) returning *",
			(twitchid, category, title))
		ret = cur.fetchone()
		id = ret["id"]
		# TODO: insertmany, but with individual error checking
		ret["communities"] = []
		for comm in communities:
			cur.execute("insert into mustard.setup_communities values (%s, %s)", (id, comm))
			ret["communities"].append(comm)
	return ret

def list_setups(twitchid):
	with postgres, postgres.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
		cur.execute("select * from mustard.setups where twitchid=%s", (twitchid,))
		ret = cur.fetchall()
		for setup in ret:
			cur.execute("select community from mustard.setup_communities where setupid=%s", (setup["id"],))
			setup["communities"] = sorted([row["community"] for row in cur])
	return ret

def delete_setup(twitchid, setupid):
	"""Attempt to delete a saved setup

	If the setupid is bad, or if it doesn't belong to the given twitchid,
	returns 0. There is no permissions-error response - just a 404ish.
	"""
	with postgres, postgres.cursor() as cur:
		cur.execute("delete from mustard.setups where twitchid=%s and id=%s", (twitchid, setupid))
		return cur.rowcount

def get_schedule(twitchid):
	"""Return the user's timezone and schedule

	Schedule currently unsupported, always returns [].
	"""
	with postgres, postgres.cursor() as cur:
		cur.execute("select sched_timezone from mustard.users where twitchid=%s", (twitchid,))
		return cur.fetchone()[0], []
