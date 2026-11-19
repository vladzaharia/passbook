import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/web/ui/index.ts';
import { IdentitiesPanel } from '../identities/identities-page.tsx';
import { ProviderTab } from './provider-tab.tsx';

/** Platform › Wallet accounts: one tab per wallet. Platform pages ignore the mode switch. */
export function PlatformWalletAccountsPage() {
  return (
    <>
      <PageHeader title="Wallet accounts" />
      <Tabs defaultValue="apple" className="flex flex-col gap-6">
        <TabsList aria-label="Wallet">
          <TabsTrigger value="apple">Apple</TabsTrigger>
          <TabsTrigger value="google">Google</TabsTrigger>
          <TabsTrigger value="samsung">Samsung</TabsTrigger>
        </TabsList>
        <TabsContent value="apple">
          <IdentitiesPanel />
        </TabsContent>
        <TabsContent value="google">
          <ProviderTab provider="google" />
        </TabsContent>
        <TabsContent value="samsung">
          <ProviderTab provider="samsung" />
        </TabsContent>
      </Tabs>
    </>
  );
}
