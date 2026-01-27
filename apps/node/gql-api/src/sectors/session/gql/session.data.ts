export interface Session {
  id: string;
  userId: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

export const sessions: Session[] = [];

export function createSession(session: Session) {
  sessions.push(session);
  return session;
}

export function getSessions() {
  return sessions;
}

export function getSessionById(id: string) {
  return sessions.find(s => s.id === id);
}
