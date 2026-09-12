/* eslint-disable react-refresh/only-export-components -- This entry point defines and mounts the viewer components. */
import './polyfills';
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Helmet, HelmetProvider } from 'react-helmet-async';
import { TooltipProvider } from './components/tooltip/tooltip';
import { ReactFlowProvider } from '@xyflow/react';
import { LocalConfigProvider } from '@/context/local-config-context/local-config-provider';
import { ThemeProvider } from '@/context/theme-context/theme-provider';
import { ChartDBProvider } from '@/context/chartdb-context/chartdb-provider';
import { Canvas } from './pages/editor-page/canvas/canvas';
import { DatabaseType, adjustTablePositions, type Diagram } from '@/lib/domain';
import { fromPostgres } from '@/lib/data/sql-import/dialect-importers/postgresql/postgresql';
import { fromMySQL } from '@/lib/data/sql-import/dialect-importers/mysql/mysql';
import { fromSQLite } from '@/lib/data/sql-import/dialect-importers/sqlite/sqlite';
import { fromSQLServer } from '@/lib/data/sql-import/dialect-importers/sqlserver/sqlserver';
import { fromOracle } from '@/lib/data/sql-import/dialect-importers/oracle/oracle';
import { convertToChartDBDiagram } from '@/lib/data/sql-import/common';

import { DiffProvider } from '@/context/diff-context/diff-provider';
import { DiagramFilterProvider } from '@/context/diagram-filter-context/diagram-filter-provider';
import { CanvasProvider } from '@/context/canvas-context/canvas-provider';
import { useChartDB } from '@/hooks/use-chartdb';
import './index.css';
import './globals.css';
import './i18n/i18n';

const importers = {
    [DatabaseType.POSTGRESQL]: fromPostgres,
    [DatabaseType.COCKROACHDB]: fromPostgres,
    [DatabaseType.MYSQL]: fromMySQL,
    [DatabaseType.MARIADB]: fromMySQL,
    [DatabaseType.SQLITE]: fromSQLite,
    [DatabaseType.SQL_SERVER]: fromSQLServer,
    [DatabaseType.ORACLE]: fromOracle,
};

// Initialize ChartDB's diagram context before mounting its filters and canvas.
const SchemaCanvas = ({ diagram }: { diagram: Diagram }) => {
    const { diagramId, loadDiagramFromData } = useChartDB();
    useEffect(() => {
        loadDiagramFromData(diagram);
    }, [diagram, loadDiagramFromData]);

    if (diagramId !== diagram.id) return null;

    return (
        <DiagramFilterProvider>
            <ReactFlowProvider>
                <CanvasProvider>
                    <Canvas initialTables={diagram.tables ?? []} />
                </CanvasProvider>
            </ReactFlowProvider>
        </DiagramFilterProvider>
    );
};

const LocalSchemaPage = ({
    databaseType,
}: {
    databaseType: keyof typeof importers;
}) => {
    const [diagram, setDiagram] = useState<Diagram>();
    const [error, setError] = useState<string>();
    const [warnings, setWarnings] = useState<string[]>();
    const [connectionError, setConnectionError] = useState<string>();
    const [syncedAt, setSyncedAt] = useState<string>();

    useEffect(() => {
        const controller = new AbortController();
        let requestedVersion = 0;
        let handledVersion = 0;
        let refreshing = false;
        let previousSQL: string | undefined;

        // Coalesce events during a fetch/import and discard superseded results.
        const refresh = async () => {
            requestedVersion++;
            if (refreshing) return;
            refreshing = true;
            try {
                while (
                    handledVersion !== requestedVersion &&
                    !controller.signal.aborted
                ) {
                    const version = requestedVersion;
                    handledVersion = version;
                    try {
                        const response = await fetch('/schema.sql', {
                            cache: 'no-store',
                            signal: controller.signal,
                        });
                        if (!response.ok) {
                            throw new Error(
                                'Cannot read schema.sql. Showing the last diagram; waiting for a save or reconnection.'
                            );
                        }
                        const sql = await response.text();
                        if (controller.signal.aborted) return;
                        if (version !== requestedVersion) continue;
                        if (sql !== previousSQL) {
                            const parsed = await importers[databaseType](sql);
                            if (controller.signal.aborted) return;
                            if (version !== requestedVersion) continue;
                            // ChartDB recovers unsupported syntax (including enum columns) using fallback
                            // parsing. Its warnings describe possible omissions, not a failed import.
                            // Keep the previous diagram only if parsing failed without recovering tables.
                            if (
                                !parsed.tables.length &&
                                parsed.warnings?.some((warning) =>
                                    warning.startsWith(
                                        'Failed to parse statement:'
                                    )
                                )
                            ) {
                                throw new Error(
                                    `${parsed.warnings.join(' ')} Showing the last diagram; waiting for a save or reconnection.`
                                );
                            }

                            const nextDiagram = convertToChartDBDiagram(
                                parsed,
                                databaseType,
                                databaseType
                            );
                            nextDiagram.name = 'Database schema';
                            nextDiagram.tables = adjustTablePositions({
                                tables: nextDiagram.tables ?? [],
                                relationships: nextDiagram.relationships ?? [],
                                mode: 'perSchema',
                            });
                            setDiagram(nextDiagram);
                            setWarnings(parsed.warnings);
                            previousSQL = sql;
                        }
                        setError(undefined);
                        setSyncedAt(new Date().toISOString());
                    } catch (cause) {
                        if (controller.signal.aborted) return;
                        setError(
                            cause instanceof Error
                                ? cause.message
                                : 'Schema refresh failed. Waiting for a save or reconnection.'
                        );
                    }
                }
            } finally {
                refreshing = false;
            }
        };

        const events = new EventSource('/events');
        events.addEventListener('schema', refresh);
        events.onopen = () => setConnectionError(undefined);
        events.onerror = () =>
            setConnectionError('Live updates disconnected. Reconnecting…');
        return () => {
            events.close();
            controller.abort();
        };
    }, [databaseType]);

    const message = connectionError ?? error;

    return (
        <LocalConfigProvider>
            <ThemeProvider>
                <Helmet>
                    <title>ChartDB Viewer</title>
                </Helmet>
                <main className="flex h-screen flex-col bg-background text-foreground">
                    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
                        <div>
                            <h1 className="text-lg font-semibold">
                                {diagram?.name ?? 'Database schema'}
                            </h1>
                            <p className="text-sm text-muted-foreground">
                                {diagram
                                    ? `${diagram.tables?.length ?? 0} tables/views · ${diagram.relationships?.length ?? 0} relationships`
                                    : 'Reading schema.sql'}
                                {syncedAt
                                    ? ` · Last updated: ${new Date(syncedAt).toLocaleTimeString()}`
                                    : ''}
                            </p>
                        </div>
                    </header>
                    {message ? (
                        <p
                            role="alert"
                            className="border-b px-5 py-2 text-sm text-destructive"
                        >
                            {message}
                        </p>
                    ) : null}
                    {warnings?.length ? (
                        <details className="border-b px-5 py-2 text-sm">
                            <summary>
                                Diagram imported with warnings; some details may
                                be incomplete.
                            </summary>
                            <p className="mt-2 whitespace-pre-wrap">
                                {warnings.join('\n')}
                            </p>
                        </details>
                    ) : null}
                    {!diagram ? (
                        <p role="status" className="p-5">
                            Loading schema.sql…
                        </p>
                    ) : diagram.tables?.length ? (
                        <div className="min-h-0 flex-1">
                            <DiffProvider key={diagram.id}>
                                <ChartDBProvider diagram={diagram} readonly>
                                    <SchemaCanvas diagram={diagram} />
                                </ChartDBProvider>
                            </DiffProvider>
                        </div>
                    ) : (
                        <p role="status" className="p-5">
                            No tables in schema.sql yet. This diagram will
                            update when the file changes.
                        </p>
                    )}
                </main>
            </ThemeProvider>
        </LocalConfigProvider>
    );
};

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<p role="status">Loading viewer configuration…</p>);

// Configuration is fixed for this page load, including across reconnections.
const initialize = async () => {
    let databaseType: keyof typeof importers;
    try {
        const response = await fetch('/config', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(
                'Cannot read viewer configuration. Reload to retry.'
            );
        }
        const settings = await response.json();
        if (
            typeof settings?.dialect !== 'string' ||
            !Object.prototype.hasOwnProperty.call(importers, settings.dialect)
        ) {
            throw new Error(
                'Invalid viewer configuration: unsupported or missing dialect.'
            );
        }
        databaseType = settings.dialect as keyof typeof importers;
    } catch (cause) {
        root.render(
            <p role="alert">
                {cause instanceof Error
                    ? cause.message
                    : 'Cannot load viewer configuration. Reload to retry.'}
            </p>
        );
        return;
    }

    root.render(
        <React.StrictMode>
            <HelmetProvider>
                <TooltipProvider>
                    <LocalSchemaPage databaseType={databaseType} />
                </TooltipProvider>
            </HelmetProvider>
        </React.StrictMode>
    );
};

void initialize();
