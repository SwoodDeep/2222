import { fetchUsers, openChatSocket } from './api';
import { unusedHelper } from './unused';

export default function App() {
  const users = fetchUsers();
  const socket = openChatSocket();
  return (
    <div className="app">
      <h1>Users</h1>
      <ul>{users.map((u) => <li key={u.id}>{u.name}</li>)}</ul>
    </div>
  );
}
