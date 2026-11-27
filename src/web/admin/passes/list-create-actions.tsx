import { Link } from '@tanstack/react-router';
import { ImagePlus, Plus, Upload } from 'lucide-react';
import { Button } from '../../ui/index.ts';

export function CreateActions({ variant }: { variant: 'primary' | 'outline' }) {
  return (
    <>
      <Button asChild variant="outline" iconStart={<Upload aria-hidden />}>
        <Link to="/admin/passes/import">Import</Link>
      </Button>
      <Button asChild variant="outline" iconStart={<ImagePlus aria-hidden />}>
        <Link to="/admin/passes/photos">Photos</Link>
      </Button>
      <Button asChild variant={variant} iconStart={<Plus aria-hidden />}>
        <Link to="/admin/passes/new">New pass</Link>
      </Button>
    </>
  );
}
