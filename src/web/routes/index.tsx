import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: () => <h1 className="p-6 text-2xl font-semibold">Wallet</h1>,
});
