import { LineChart } from 'hew/LineChart';
import Message from 'hew/Message';
import { useModal } from 'hew/Modal';
import Spinner from 'hew/Spinner';
import { Loadable, Loaded, NotLoaded } from 'hew/utils/loadable';
import _ from 'lodash';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import Section from 'components/Section';
import TableBatch from 'components/Table/TableBatch';
import useUI from 'components/ThemeProvider';
import { UPlotPoint } from 'components/UPlot/types';
import { terminalRunStates } from 'constants/states';
import TrialsComparisonModalComponent from 'pages/ExperimentDetails/TrialsComparisonModal';
import { paths } from 'routes/utils';
import { openOrCreateTensorBoard } from 'services/api';
import { V1TrialsSampleResponse } from 'services/api-ts-sdk';
import { detApi } from 'services/apiConfig';
import { readStream } from 'services/utils';
import {
  ExperimentAction as Action,
  CommandResponse,
  ExperimentBase,
  ExperimentSearcherName,
  Hyperparameter,
  HyperparameterType,
  Metric,
  RunState,
  Scale,
  Serie,
  XAxisDomain,
} from 'types';
import { glasbeyColor } from 'utils/color';
import { flattenObject, isPrimitive } from 'utils/data';
import handleError, { ErrorLevel, ErrorType } from 'utils/error';
import { metricToStr } from 'utils/metric';
import { isNewTabClickEvent, openBlank, routeToReactUrl } from 'utils/routes';
import { openCommandResponse } from 'utils/wait';

import HpTrialTable, { TrialHParams } from './HpTrialTable';
import css from './LearningCurve.module.scss';

interface Props {
  experiment: ExperimentBase;
  filters?: React.ReactNode;
  fullHParams: string[];
  selectedMaxTrial: number;
  selectedMetric?: Metric;
  selectedScale: Scale;
}

const MAX_DATAPOINTS = 5000;

export const getCustomSearchVaryingHPs = (
  trialHps: TrialHParams[],
): Record<string, Hyperparameter> => {
  /**
   * For Custom Searchers, add a hyperparameter's column for params that
   * 1) Have more than one unique value (it isn't the same in all trials)
   * 2) Isn't a dictionary of other metrics
   * This is to bypass the need to rely the on the experiment config's
   * definition of hyperparameters and determine what should be shown more dynamically.
   *
   * Note: If we support the other tabs in the future for Custom Searchers
   * such as HpParallelCoordinates, HpScatterPlots, and HpHeatMaps, we will need to
   * generalize this logic a bit.
   */
  const uniq = new Set<string>();
  const check_dict = {} as Record<string, unknown>;
  trialHps.forEach((d) => {
    Object.keys(d.hparams).forEach((key: string) => {
      const value = d.hparams[key];
      if (!(isPrimitive(value) || Array.isArray(value))) {
        /**
         * We have both the flattened and unflattened values in this TrialHParams
         * From `const flatHParams = { ...trial.hparams, ...flattenObject(trial.hparams || {}) };`
         * below in the file. Skip the non flattened dictionaries.
         * Example: {
         *  "dict": { # This is skipped
         *    "key": "value"
         *  },
         *  "dict.key": "value", # This is allowed
         * }
         */
        return;
      }
      if (!(key in check_dict)) {
        check_dict[key] = value;
      } else if (!_.isEqual(check_dict[key], value)) {
        uniq.add(key);
      }
    });
  });

  // If there's only one result, don't filter by unique results
  const all_keys = trialHps.length === 1 ? Object.keys(check_dict) : Array.from(uniq);
  return all_keys.reduce(
    (acc, key) => {
      acc[key] = {
        type: HyperparameterType.Constant,
      };
      return acc;
    },
    {} as Record<string, Hyperparameter>,
  );
};

const LearningCurve: React.FC<Props> = ({
  experiment,
  filters,
  fullHParams,
  selectedMaxTrial,
  selectedMetric,
  selectedScale,
}: Props) => {
  const { ui } = useUI();
  const [trialIds, setTrialIds] = useState<number[]>([]);
  const [chartData, setChartData] = useState<Loadable<Serie[]>>(NotLoaded);
  const [trialHps, setTrialHps] = useState<TrialHParams[]>([]);
  const [highlightedTrialId, setHighlightedTrialId] = useState<number>();
  const [hasLoaded, setHasLoaded] = useState(false);
  const [pageError, setPageError] = useState<Error>();
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([]);
  const trialsComparisonModal = useModal(TrialsComparisonModalComponent);
  const hasTrials = trialHps.length !== 0;
  const isExperimentTerminal = terminalRunStates.has(experiment.state as RunState);

  const hyperparameters = useMemo(() => {
    if (experiment.config.searcher.name === ExperimentSearcherName.Custom && trialHps.length > 0) {
      return getCustomSearchVaryingHPs(trialHps);
    } else {
      return fullHParams.reduce(
        (acc, key) => {
          acc[key] = experiment.hyperparameters[key];
          return acc;
        },
        {} as Record<string, Hyperparameter>,
      );
    }
  }, [experiment.hyperparameters, fullHParams, trialHps, experiment.config]);

  const handleTrialClick = useCallback(
    (event: MouseEvent, trialId: number) => {
      const href = paths.trialDetails(trialId, experiment.id);
      if (isNewTabClickEvent(event)) openBlank(href);
      else routeToReactUrl(href);
    },
    [experiment.id],
  );

  const handleTrialFocus = useCallback((trialId: number | null) => {
    setHighlightedTrialId(trialId != null ? trialId : undefined);
  }, []);

  const handlePointClick = useCallback(
    (e: MouseEvent, point: UPlotPoint) => {
      const trialId = trialIds[point.seriesIdx];
      if (trialId) handleTrialClick(e, trialId);
    },
    [handleTrialClick, trialIds],
  );

  const handlePointFocus = useCallback(
    (point?: UPlotPoint) => {
      const trialId = point ? trialIds[point.seriesIdx] : undefined;
      if (trialId) handleTrialFocus(trialId);
    },
    [handleTrialFocus, trialIds],
  );

  const handleTableMouseEnter = useCallback((_event: React.MouseEvent, record: TrialHParams) => {
    if (record.id) setHighlightedTrialId(record.id);
  }, []);

  const handleTableMouseLeave = useCallback(() => {
    setHighlightedTrialId(undefined);
  }, []);

  const clearSelected = useCallback(() => {
    setSelectedRowKeys([]);
  }, []);

  useEffect(() => {
    if (ui.isPageHidden || !selectedMetric) return;

    const canceler = new AbortController();
    const trialIdsMap: Record<number, number> = {};
    const trialHpMap: Record<number, TrialHParams> = {};
    const metricsMap: Record<number, [number, number][]> = {};

    setHasLoaded(false);

    readStream<V1TrialsSampleResponse>(
      detApi.StreamingInternal.trialsSample(
        experiment.id,
        selectedMetric.name,
        undefined,
        selectedMetric.group,
        selectedMaxTrial,
        MAX_DATAPOINTS,
        undefined,
        undefined,
        undefined,
        { signal: canceler.signal },
      ),
      (event) => {
        if (!event?.trials || !Array.isArray(event.trials)) return;

        /*
         * Cache trial ids, hparams, and metric values into easily searchable
         * dictionaries, then construct the necessary data structures to render the
         * chart and the table.
         */

        (event.promotedTrials || []).forEach((trialId) => (trialIdsMap[trialId] = trialId));
        (event.demotedTrials || []).forEach((trialId) => delete trialIdsMap[trialId]);
        const newTrialIds = Object.values(trialIdsMap);
        setTrialIds(newTrialIds);

        (event.trials || []).forEach((trial) => {
          const id = trial.trialId;

          // This allows for both typical nested hyperparameters and nested categorgical
          // hyperparameter values to be shown, with HpTrialTable deciding which are displayed.
          const flatHParams = { ...trial.hparams, ...flattenObject(trial.hparams || {}) };

          const hasHParams = Object.keys(flatHParams).length !== 0;

          if (hasHParams && !trialHpMap[id]) {
            trialHpMap[id] = { hparams: flatHParams, id, metric: null };
          }

          metricsMap[id] = [];

          trial.data.forEach((datapoint) => {
            metricsMap[id].push([datapoint.batches, datapoint.values[selectedMetric.name]]);
            trialHpMap[id].metric = datapoint.values[selectedMetric.name];
          });
        });

        const newTrialHps = newTrialIds.map((id) => trialHpMap[id]);
        setTrialHps(newTrialHps);

        const newChartData: Serie[] = newTrialIds
          .filter((trialId) => !selectedRowKeys.length || selectedRowKeys.includes(trialId))
          .map((trialId) => ({
            color: glasbeyColor(trialId),
            data: { [XAxisDomain.Batches]: metricsMap[trialId] },
            key: trialId,
            name: `trial ${trialId}`,
          }));
        setChartData(Loaded(newChartData));

        // One successful event as come through.
        setHasLoaded(true);
      },
      (e) => {
        setPageError(e);
        setHasLoaded(true);
      },
    );

    return () => canceler.abort();
  }, [experiment.id, selectedMaxTrial, selectedMetric, selectedRowKeys, ui.isPageHidden]);

  const sendBatchActions = useCallback(
    async (action: Action) => {
      if (action === Action.OpenTensorBoard) {
        return await openOrCreateTensorBoard({
          trialIds: selectedRowKeys,
          workspaceId: experiment.workspaceId,
        });
      } else if (action === Action.CompareTrials) {
        return trialsComparisonModal.open();
      }
    },
    [trialsComparisonModal, selectedRowKeys, experiment],
  );

  const submitBatchAction = useCallback(
    async (action: Action) => {
      try {
        const result = await sendBatchActions(action);
        if (action === Action.OpenTensorBoard && result) {
          openCommandResponse(result as CommandResponse);
        }
      } catch (e) {
        const publicSubject =
          action === Action.OpenTensorBoard
            ? 'Unable to View TensorBoard for Selected Trials'
            : `Unable to ${action} Selected Trials`;
        handleError(e, {
          level: ErrorLevel.Error,
          publicMessage: 'Please try again later.',
          publicSubject,
          silent: false,
          type: ErrorType.Server,
        });
      }
    },
    [sendBatchActions],
  );

  const handleTableRowSelect = useCallback(
    (rowKeys: unknown) => setSelectedRowKeys(rowKeys as number[]),
    [],
  );

  const handleTrialUnselect = useCallback(
    (trialId: number) => setSelectedRowKeys((rowKeys) => rowKeys.filter((id) => id !== trialId)),
    [],
  );

  if (pageError) {
    return <Message title={pageError.message} />;
  } else if ((hasLoaded && !hasTrials) || !selectedMetric) {
    return isExperimentTerminal ? (
      <Message icon="warning" title="No learning curve data to show." />
    ) : (
      <div className={css.waiting}>
        <Message
          description="Please wait until the experiment is further along."
          title="Not enough data points to plot."
        />
        <Spinner center spinning />
      </div>
    );
  }

  return (
    <div className={css.base}>
      <Section bodyBorder bodyScroll filters={filters} loading={!hasLoaded}>
        <div className={css.container}>
          <div className={css.chart}>
            <LineChart
              focusedSeries={highlightedTrialId && trialIds.indexOf(highlightedTrialId)}
              handleError={handleError}
              scale={selectedScale}
              series={chartData}
              xLabel="Batches Processed"
              yLabel={metricToStr(selectedMetric)}
              onPointClick={handlePointClick}
              onPointFocus={handlePointFocus}
            />
          </div>
          <TableBatch
            actions={[
              { label: Action.OpenTensorBoard, value: Action.OpenTensorBoard },
              { label: Action.CompareTrials, value: Action.CompareTrials },
            ]}
            selectedRowCount={selectedRowKeys.length}
            onAction={(action) => submitBatchAction(action as Action)}
            onClear={clearSelected}
          />
          <HpTrialTable
            experimentId={experiment.id}
            handleTableRowSelect={handleTableRowSelect}
            highlightedTrialId={highlightedTrialId}
            hyperparameters={hyperparameters}
            metric={selectedMetric}
            selectedRowKeys={selectedRowKeys}
            selection={true}
            trialHps={trialHps}
            onMouseEnter={handleTableMouseEnter}
            onMouseLeave={handleTableMouseLeave}
          />
        </div>
      </Section>
      <trialsComparisonModal.Component
        experiment={experiment}
        trialIds={selectedRowKeys}
        onUnselect={handleTrialUnselect}
      />
    </div>
  );
};

export default LearningCurve;
