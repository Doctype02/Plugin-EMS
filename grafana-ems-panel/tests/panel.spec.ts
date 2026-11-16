import { test, expect } from '@grafana/plugin-e2e';

const ZONAS = Array.from({ length: 26 }, (_, i) => `Z${String(i + 1).padStart(2, '0')}`);

test('muestra el edificio con las 26 zonas', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await expect(panel.getByTestId('ems-building')).toBeVisible();
  // por defecto se ve una planta; "Edificio" abre la vista de conjunto con todas
  await expect(panel.getByTestId('ems-floor-selector')).toBeVisible();
  await panel.getByTestId('ems-floorsel-all').click();
  for (const zona of ZONAS) {
    await expect(panel.getByTestId(`ems-zone-${zona}`)).toHaveCount(1);
  }
  for (const planta of ['PB', 'P1', 'P2', 'P3', 'P4']) {
    await expect(panel.getByTestId(`ems-floor-${planta}`)).toHaveCount(1);
  }
  await expect(panel.getByTestId('ems-roof')).toBeVisible();
  await expect(panel.getByTestId('ems-roof-VRF-P4')).toHaveCount(1);
  // modo demostración con FV automática: campos fotovoltaicos en la azotea
  await expect(panel.getByTestId('ems-pv-FV-1')).toHaveCount(1);
  // la azotea a tamaño completo rotula cada campo FV
  await panel.getByTestId('ems-floorsel-roof').click();
  await expect(panel.getByTestId('ems-pv-label-FV-1')).toBeVisible();
});

test('el selector cambia de planta', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-floorsel-P3').click();
  await expect(panel.getByTestId('ems-floor-P3')).toHaveCount(1);
  await expect(panel.getByTestId('ems-floor-PB')).toHaveCount(0);
  await expect(panel.getByTestId('ems-scene-title')).toContainText('P3');
  await panel.getByTestId('ems-floorsel-all').click();
  await panel.getByTestId('ems-level-label-P1').click();
  await expect(panel.getByTestId('ems-scene-title')).toContainText('P1');
});

test('abre el detalle de la zona al hacer clic', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-floorsel-PB').click();
  await panel.getByTestId('ems-zone-Z06').click();
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
  await expect(panelEditPage.panel.locator.getByTestId('ems-count-offline')).toContainText('26');
});

test('la vista exterior apila los pisos', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-floorsel-all').click();
  await panel.getByTestId('ems-explode').click();
  await expect(panel.getByTestId('ems-floor-P4')).toBeVisible();
  await expect(panel.getByTestId('ems-level-label-P4')).toBeVisible();
});

test('muestra el interior animado en la vista en corte', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await expect(panel.getByTestId('ems-building')).toHaveAttribute('data-animated', 'si');
  await panel.getByTestId('ems-floorsel-all').click();
  await expect(panel.getByTestId('ems-riser')).toBeVisible();
  await panel.getByTestId('ems-animate').click();
  await expect(panel.getByTestId('ems-building')).toHaveAttribute('data-animated', 'no');
});

test('controla una zona en modo demostración', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-floorsel-PB').click();
  await panel.getByTestId('ems-zone-Z02').click();
  const control = panel.getByTestId('ems-zone-control');
  await expect(control).toBeVisible();
  await control.getByRole('radio', { name: 'Apagar' }).check({ force: true });
  await panel.getByTestId('ems-control-apply').click();
  // apagar el HVAC pide confirmación
  await panel.getByTestId('ems-control-confirm-ok').click();
  await expect(panel.getByTestId('ems-send-status')).toHaveAttribute('data-phase', 'ok');
  await expect(panel.getByTestId('ems-manual-Z02')).toBeVisible();
  await panel.getByTestId('ems-control-release').click();
  await expect(panel.getByTestId('ems-manual-Z02')).toHaveCount(0);
});

test('las zonas críticas no se pueden controlar', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByTestId('ems-floorsel-PB').click();
  await panel.getByTestId('ems-zone-Z06').click();
  await expect(panel.getByTestId('ems-control-locked')).toBeVisible();
});

test('los parámetros del EMS se validan y se confirman', async ({ gotoPanelEditPage, readProvisionedDashboard }) => {
  const dashboard = await readProvisionedDashboard({ fileName: 'dashboard.json' });
  const panelEditPage = await gotoPanelEditPage({ dashboard, id: '1' });
  const panel = panelEditPage.panel.locator;

  await panel.getByRole('tab', { name: /Control/ }).click();
  const limit = panel.getByTestId('ems-param-limit-input');
  await expect(limit).toHaveValue('170');
  await limit.fill('900');
  await expect(panel.getByTestId('ems-params-apply')).toBeDisabled();
  await limit.fill('150');
  await panel.getByTestId('ems-params-apply').click();
  await panel.getByTestId('ems-params-confirm-ok').click();
  await expect(panel.getByTestId('ems-send-status')).toHaveAttribute('data-phase', 'ok');
});
