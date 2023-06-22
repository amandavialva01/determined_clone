package idle

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/determined-ai/determined/master/internal/sproto"
)

func TestIdleTimeoutWatcherUseRunnerState(t *testing.T) {
	TickInterval = 10 * time.Millisecond
	var actionDone atomic.Bool
	timeout := time.Second
	cfg := sproto.IdleTimeoutConfig{
		ServiceID:       "test",
		TimeoutDuration: timeout,
		UseRunnerState:  true,
	}

	Register(cfg, func(error) {
		actionDone.Store(true)
	})
	defer Unregister(cfg.ServiceID)

	RecordActivity(cfg.ServiceID)

	waitForCondition(10*timeout, actionDone.Load)
}

func waitForCondition(timeout time.Duration, condition func() bool) {
	for i := 0; i < int(timeout/TickInterval); i++ {
		if condition() {
			return
		}
		time.Sleep(TickInterval)
	}
}
