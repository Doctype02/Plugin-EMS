import { test, expect } from '@grafana/plugin-e2e';

test('muestra el edificio con las 10 zonas', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await expect(panel.getByTestId('ems-building')).toBeVisible();
  for (const zona of ['Z01', 'Z02', 'Z03', 'Z04', 'Z05', 'Z06', 'Z07', 'Z08', 'Z09', 'Z10']) {
    await expect(panel.getByTestId(`ems-zone-${zona}`)).toHaveCount(1);
  }
  await expect(panel.getByTestId('ems-roof')).toBeVisible();
});

test('abre el detalle de la zona al hacer clic', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-zone-Z09').click();
  await expect(panel.getByTestId('ems-detail')).toContainText('Cuarto de servidores');
  await expect(panel.getByTestId('ems-detail')).toContainText('carga crítica');
});

test('cambia la leyenda con la vista de temperatura', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByRole('radio', { name: 'Temperatura' }).check({ force: true });
  await expect(panel.getByTestId('ems-legend')).toContainText('Temperatura respecto al setpoint');
});

test('sin datos de demostración todas las zonas quedan sin datos', async ({
  gotoPanelEditPage,
  readProvisionedDashboard,
}) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const options = panelEditPage.getCustomOptions('EMS Edificio');

  await options.getSwitch('Datos de demostración').uncheck();
  await expect(panelEditPage.panel.locator.getByTestId('ems-count-offline')).toContainText('10');
});

test('la vista exterior apila los pisos', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-explode').click();
  await expect(panel.getByTestId('ems-floor-PA')).toBeVisible();
  await expect(panel.getByText('Azotea · unidades VRF')).toHaveCount(0);
});

test('muestra el interior animado en la vista en corte', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await expect(panel.getByTestId('ems-building')).toHaveAttribute('data-animated', 'si');
  await expect(panel.getByTestId('ems-riser')).toBeVisible();
  await panel.getByTestId('ems-animate').click();
  await expect(panel.getByTestId('ems-building')).toHaveAttribute('data-animated', 'no');
});

test('controla una zona en modo demostración', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-zone-Z02').click();
  const control = panel.getByTestId('ems-zone-control');
  await expect(control).toBeVisible();
  await control.getByRole('radio', { name: 'Apagar' }).check({ force: true });
  await panel.getByTestId('ems-control-apply').click();
  await expect(panel.getByTestId('ems-manual-Z02')).toBeVisible();
  await panel.getByTestId('ems-control-release').click();
  await expect(panel.getByTestId('ems-manual-Z02')).toHaveCount(0);
});

test('las zonas críticas no se pueden controlar', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-zone-Z09').click();
  await expect(panel.getByTestId('ems-control-locked')).toBeVisible();
});
