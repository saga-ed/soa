"use client";
import PropTypes from 'prop-types';

export const Button = ({ children, className, appName }) => {
  return (<button className={className} onClick={() => alert(`Hello from your ${appName} app!`)}>
    {children}
  </button>);
};

Button.propTypes = {
  children: PropTypes.node,
  className: PropTypes.string,
  appName: PropTypes.string,
};
