import { createFileRoute } from '@tanstack/react-router';
import { MessagesPage } from '../../../admin/messages/messages-page.tsx';

export const Route = createFileRoute('/admin/messages/')({ component: MessagesPage });
