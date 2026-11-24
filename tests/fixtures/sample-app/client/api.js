import axios from 'axios';

export async function fetchUsers() {
  const res = await fetch('/api/users');
  return res.json();
}

export async function fetchUser(id) {
  return axios.get(`/api/users/${id}`);
}

export function openChatSocket() {
  return new WebSocket('/ws/chat');
}

export function listenEvents() {
  window.addEventListener('resize', () => {});
}
