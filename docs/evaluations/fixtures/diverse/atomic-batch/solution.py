def add_users(conn, rows):
    for user_id, name in rows:
        conn.execute("INSERT INTO users(id, name) VALUES (?, ?)", (user_id, name))
        conn.commit()
