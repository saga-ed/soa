export interface User {
  id: string;
  name: string;
  email: string;
}

export const users: User[] = [];

export function createUser(user: User) {
  users.push(user);
  return user;
}

export function getUsers() {
  return users;
}

export function getUserById(id: string) {
  return users.find(u => u.id === id);
}
