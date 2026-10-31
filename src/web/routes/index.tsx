import { createFileRoute } from '@tanstack/react-router';
import { MyPassesPage } from '../portal/my-passes-page.tsx';

export const Route = createFileRoute('/')({ component: MyPassesPage });
