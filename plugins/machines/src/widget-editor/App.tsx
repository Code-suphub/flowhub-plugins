import { useEffect, useRef, useState } from 'react';
import { Checkbox, Field, Select } from '@flowhub/plugin-common/react';

import {
  DISPLAY_OPTIONS,
  EDITOR_LABELS,
  selectedOptionsFromConfig,
} from './options';
import type {
  DisplayOptionKey,
  EditorState,
  EditorStatus,
  MachineMetricKey,
  MachineWidgetConfig,
} from './types';

const INITIAL_STATE: EditorState = {
  row: '',
  rows: [],
  selected: [],
  initialized: false,
};

const INITIAL_STATUS: EditorStatus = {
  message: EDITOR_LABELS.loading,
  tone: 'muted',
};

const META_OPTIONS = new Set<DisplayOptionKey>(['country', 'expiry']);

function validateEditorState(state: EditorState): MachineWidgetConfig {
  if (!state.row) {
    throw new Error(EDITOR_LABELS.selectMachine);
  }
  if (state.selected.length === 0) {
    throw new Error(EDITOR_LABELS.selectMetric);
  }

  const metrics = state.selected.filter(
    (key): key is MachineMetricKey => !META_OPTIONS.has(key),
  );

  return {
    view: 'machine',
    row: state.row,
    metrics,
    showCountry: state.selected.includes('country'),
    showExpiry: state.selected.includes('expiry'),
  };
}

interface MetricSelectorProps {
  selected: readonly DisplayOptionKey[];
  onChange: (key: DisplayOptionKey, checked: boolean) => void;
}

function MetricSelector({ selected, onChange }: MetricSelectorProps) {
  return (
    <fieldset className="widget-editor__metrics">
      <legend>{EDITOR_LABELS.metrics}</legend>
      <div className="widget-editor__metric-grid">
        {DISPLAY_OPTIONS.map((option) => (
          <Checkbox
            key={option.value}
            label={option.label}
            checked={selected.includes(option.value)}
            onChange={(checked) => onChange(option.value, checked)}
          />
        ))}
      </div>
    </fieldset>
  );
}

interface StatusMessageProps {
  status: EditorStatus;
}

function StatusMessage({ status }: StatusMessageProps) {
  return (
    <p
      className="widget-editor__status"
      data-tone={status.tone}
      role={status.tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      <span className="widget-editor__status-dot" aria-hidden="true" />
      <span>{status.message}</span>
    </p>
  );
}

export function App() {
  const [editorState, setEditorState] = useState<EditorState>(INITIAL_STATE);
  const [status, setStatus] = useState<EditorStatus>(INITIAL_STATUS);
  const editorStateRef = useRef(editorState);
  editorStateRef.current = editorState;

  useEffect(() => {
    window.FlowHubWidget.onInit((context) => {
      const rows = context.snapshot?.rows ?? [];
      const requestedRow = context.config?.row || rows[0]?.id || '';
      const row = rows.some((candidate) => candidate.id === requestedRow)
        ? requestedRow
        : '';

      setEditorState({
        row,
        rows,
        selected: selectedOptionsFromConfig(context.config),
        initialized: true,
      });
      setStatus({
        message: rows.length > 0
          ? EDITOR_LABELS.loaded(rows.length)
          : EDITOR_LABELS.noMachines,
        tone: rows.length > 0 ? 'success' : 'error',
      });
    });

    window.FlowHubWidget.editor(() => {
      try {
        const config = validateEditorState(editorStateRef.current);
        setStatus({ message: EDITOR_LABELS.valid, tone: 'success' });
        return config;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStatus({ message, tone: 'error' });
        throw error;
      }
    });
  }, []);

  const markChanged = () => {
    setStatus({ message: EDITOR_LABELS.changed, tone: 'muted' });
  };

  const selectRow = (row: string) => {
    setEditorState((current) => ({ ...current, row }));
    markChanged();
  };

  const toggleOption = (key: DisplayOptionKey, checked: boolean) => {
    setEditorState((current) => ({
      ...current,
      selected: checked
        ? current.selected.includes(key)
          ? current.selected
          : [...current.selected, key]
        : current.selected.filter((selectedKey) => selectedKey !== key),
    }));
    markChanged();
  };

  const machineOptions = editorState.rows.map((row) => ({
    value: row.id,
    label: row.name,
  }));

  return (
    <main className="widget-editor" aria-busy={!editorState.initialized}>
      <Field label={EDITOR_LABELS.machine} htmlFor="machine-row">
        <Select
          id="machine-row"
          value={editorState.row}
          options={machineOptions}
          onChange={selectRow}
          disabled={!editorState.initialized || machineOptions.length === 0}
        />
      </Field>

      <MetricSelector selected={editorState.selected} onChange={toggleOption} />

      <p className="widget-editor__hint">{EDITOR_LABELS.trafficHint}</p>
      <StatusMessage status={status} />
    </main>
  );
}
