import React from 'react';
import styled from 'styled-components';

const Panel = styled.div`
  color: red;
`;

export function Widget() {
  return (
    <Panel>
      <h2 data-testid="widget-title">Old widget</h2>
    </Panel>
  );
}
