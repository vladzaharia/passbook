import { createFileRoute } from '@tanstack/react-router';
import { PhotosPage } from '../../../../../admin/passes/photos/photos-page.tsx';

export const Route = createFileRoute('/admin/o/$orgId/passes/photos')({
  component: PhotosPage,
});
